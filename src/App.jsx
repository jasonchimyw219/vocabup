import { useState, useEffect, useCallback } from "react";

const SK = {
  vocab:    "hkdse_vocab_list",
  quiz:     "hkdse_quiz_state",
  lastQuiz: "hkdse_last_quiz_date",
  streak:   "hkdse_streak",
};

// ── Replace this with your Cloudflare Worker URL ──────────────────────────────
const WORKER_URL = "https://vocabup-proxy.jasonchimyw.workers.dev/";
// ─────────────────────────────────────────────────────────────────────────────

function getTodayStr() { return new Date().toISOString().split("T")[0]; }
function getYesterdayStr() { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().split("T")[0]; }

function calcWeight(v) {
  const shown = v.timesShown || 0;
  const correct = v.timesCorrect || 0;
  const ratio = shown === 0 ? 0 : correct / shown;
  const daysSince = v.lastShown
    ? Math.max(0, (Date.now() - new Date(v.lastShown).getTime()) / 86400000)
    : 999;
  const recencyBonus = Math.min(daysSince * 0.3, 3);
  return Math.max(1, 5 - ratio * 4 + recencyBonus);
}

function weightedSample(list, n) {
  const pool = list.map(v => ({ ...v, _w: calcWeight(v) }));
  const totalW = pool.reduce((s, v) => s + v._w, 0);
  const picked = [], used = new Set();
  const cap = Math.min(n, pool.length);
  let safety = 0;
  while (picked.length < cap && safety++ < 300) {
    let r = Math.random() * totalW;
    let added = false;
    for (const v of pool) {
      r -= v._w;
      if (r <= 0 && !used.has(v.id)) { picked.push(v); used.add(v.id); added = true; break; }
    }
    if (!added) {
      for (const v of pool) { if (!used.has(v.id)) { picked.push(v); used.add(v.id); break; } }
    }
  }
  return picked;
}

function buildQuiz(vocabList) {
  if (!vocabList.length) return [];
  return weightedSample(vocabList, 10).map(v => ({
    id: v.id, word: v.word, blankSentence: v.blankSentence,
    sampleSentence: v.sampleSentence, answer: v.word.toLowerCase().trim(),
    userAnswer: "", status: "unanswered",
  }));
}

// ── Gemini API call (via your Cloudflare Worker) ──────────────────────────────
async function fetchWordData(word) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word }),
  });
  const data = await res.json();
  return JSON.parse(data.text.replace(/```json|```/g, "").trim());
}
// ─────────────────────────────────────────────────────────────────────────────

const TABS = ["Learn", "My Vocab", "Daily Quiz"];
const diffColor = { Foundation: "#0F6E56", Core: "#185FA5", Extended: "#533AB7" };
const diffBg    = { Foundation: "#E1F5EE", Core: "#E6F1FB", Extended: "#EEEDFE" };

function StreakBadge({ streak }) {
  if (!streak || streak.count === 0) return null;
  const flames = streak.count >= 30 ? "🔥🔥🔥" : streak.count >= 7 ? "🔥🔥" : "🔥";
  return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:5, background:"#FAEEDA", border:"0.5px solid #FAC775", borderRadius:99, padding:"3px 12px", fontSize:13, fontWeight:500, color:"#633806" }}>
      {flames} {streak.count} day{streak.count > 1 ? " streak" : ""}
    </div>
  );
}

function SRBadge({ v }) {
  const shown = v.timesShown || 0;
  if (shown === 0) return <span style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>New</span>;
  const pct = Math.round((v.timesCorrect / shown) * 100);
  const color = pct >= 80 ? "#0F6E56" : pct >= 50 ? "#185FA5" : "#A32D2D";
  const bg    = pct >= 80 ? "#E1F5EE" : pct >= 50 ? "#E6F1FB" : "#FCEBEB";
  return <span style={{ fontSize:11, background:bg, color, borderRadius:99, padding:"2px 7px" }}>{pct}% ({shown}×)</span>;
}

export default function App() {
  const [tab, setTab]                 = useState(0);
  const [vocabList, setVocabList]     = useState([]);
  const [inputWord, setInputWord]     = useState("");
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");
  const [previewCard, setPreviewCard] = useState(null);
  const [quiz, setQuiz]               = useState([]);
  const [quizDone, setQuizDone]       = useState(false);
  const [quizStarted, setQuizStarted] = useState(false);
  const [currentQ, setCurrentQ]       = useState(0);
  const [showResult, setShowResult]   = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [streak, setStreak]           = useState({ count:0, lastDate:"" });

  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get(SK.vocab);  if (r) setVocabList(JSON.parse(r.value)); } catch(_){}
      try { const s = await window.storage.get(SK.streak); if (s) setStreak(JSON.parse(s.value)); }   catch(_){}
      setStorageReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    window.storage.set(SK.vocab, JSON.stringify(vocabList)).catch(()=>{});
  }, [vocabList, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    window.storage.set(SK.streak, JSON.stringify(streak)).catch(()=>{});
  }, [streak, storageReady]);

  useEffect(() => {
    if (tab !== 2 || !vocabList.length) return;
    (async () => {
      try {
        const r = await window.storage.get(SK.lastQuiz);
        const lastDate = r ? r.value : "";
        const today = getTodayStr();
        let savedQuiz = null;
        try { const qr = await window.storage.get(SK.quiz); if (qr) savedQuiz = JSON.parse(qr.value); } catch(_){}
        if (lastDate === today && savedQuiz) {
          setQuiz(savedQuiz);
          const allDone = savedQuiz.every(q => q.status !== "unanswered");
          setQuizStarted(true); setQuizDone(allDone);
          const first = savedQuiz.findIndex(q => q.status === "unanswered");
          setCurrentQ(first === -1 ? savedQuiz.length - 1 : first);
        } else {
          setQuiz(buildQuiz(vocabList)); setQuizStarted(false); setQuizDone(false); setCurrentQ(0);
        }
      } catch(_){}
    })();
  }, [tab, vocabList]);

  const saveQuiz = useCallback(async q => {
    await window.storage.set(SK.quiz, JSON.stringify(q)).catch(()=>{});
    await window.storage.set(SK.lastQuiz, getTodayStr()).catch(()=>{});
  }, []);

  function updateStreak() {
    const today = getTodayStr(), yesterday = getYesterdayStr();
    setStreak(prev => {
      if (prev.lastDate === today) return prev;
      return { count: prev.lastDate === yesterday ? prev.count + 1 : 1, lastDate: today };
    });
  }

  function updateVocabStats(wordId, wasCorrect) {
    setVocabList(prev => prev.map(v => {
      if (v.id !== wordId) return v;
      return { ...v, timesShown: (v.timesShown||0)+1, timesCorrect: (v.timesCorrect||0)+(wasCorrect?1:0), lastShown: getTodayStr() };
    }));
  }

  async function handleLookup() {
    if (!inputWord.trim()) return;
    setLoading(true); setError(""); setPreviewCard(null);
    try { setPreviewCard(await fetchWordData(inputWord.trim())); }
    catch(_) { setError("Could not look up this word. Check your connection and try again."); }
    setLoading(false);
  }

  function handleSave() {
    if (!previewCard) return;
    if (vocabList.find(v => v.word.toLowerCase() === previewCard.word.toLowerCase())) {
      setError("This word is already in your list!"); return;
    }
    setVocabList(prev => [{ ...previewCard, id: Date.now(), addedDate: getTodayStr(), timesShown:0, timesCorrect:0, lastShown:null }, ...prev]);
    setPreviewCard(null); setInputWord(""); setError(""); setTab(1);
  }

  function handleDelete(id) { setVocabList(prev => prev.filter(v => v.id !== id)); }

  function startQuiz() {
    const q = buildQuiz(vocabList);
    setQuiz(q); setCurrentQ(0); setQuizStarted(true); setQuizDone(false); setShowResult(false);
    saveQuiz(q);
  }

  function handleAnswer(val) {
    setQuiz(prev => prev.map((q,i) => i===currentQ ? {...q, userAnswer:val} : q));
  }

  function submitAnswer() {
    const q = quiz[currentQ];
    const correct = q.userAnswer.toLowerCase().trim() === q.answer;
    updateVocabStats(q.id, correct);
    setQuiz(prev => {
      const updated = prev.map((item,i) => i===currentQ ? {...item, status: correct?"correct":"wrong"} : item);
      saveQuiz(updated);
      return updated;
    });
    setShowResult(true);
  }

  function nextQuestion() {
    setShowResult(false);
    if (currentQ + 1 >= quiz.length) { setQuizDone(true); updateStreak(); }
    else setCurrentQ(p => p+1);
  }

  const score = quiz.filter(q => q.status === "correct").length;
  const todayDone = streak.lastDate === getTodayStr();

  return (
    <div style={{ fontFamily:"var(--font-sans)", maxWidth:680, margin:"0 auto", padding:"1.5rem 1rem" }}>
      <h2 className="sr-only">VocabUp — HKDSE English Vocabulary App</h2>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1.5rem", flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
            <span style={{ fontSize:22, fontWeight:500 }}>VocabUp</span>
            <span style={{ fontSize:13, color:"var(--color-text-secondary)", background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:99, padding:"2px 10px" }}>HKDSE F4–6</span>
          </div>
          <p style={{ fontSize:14, color:"var(--color-text-secondary)", margin:"4px 0 0" }}>Build vocabulary. Train memory. Ace the exam.</p>
        </div>
        <StreakBadge streak={streak} />
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:4, marginBottom:"1.5rem", borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
        {TABS.map((t,i) => (
          <button key={t} onClick={() => setTab(i)} style={{
            background:"none", border:"none",
            borderBottom: tab===i ? "2px solid var(--color-text-primary)" : "2px solid transparent",
            color: tab===i ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            fontWeight: tab===i ? 500 : 400, fontSize:15, padding:"8px 14px", cursor:"pointer", borderRadius:0,
            display:"flex", alignItems:"center", gap:6,
          }}>
            {i===2 && quizStarted && !quizDone && <span style={{ width:7, height:7, borderRadius:"50%", background:"#E24B4A", display:"inline-block" }} />}
            {t}
            {i===1 && vocabList.length > 0 && <span style={{ fontSize:11, background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:99, padding:"1px 7px" }}>{vocabList.length}</span>}
          </button>
        ))}
      </div>

      {/* ── LEARN ── */}
      {tab === 0 && (
        <div>
          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            <input value={inputWord} onChange={e => setInputWord(e.target.value)}
              onKeyDown={e => e.key==="Enter" && handleLookup()}
              placeholder="Type a word or phrase…"
              style={{ flex:1, fontSize:15, padding:"8px 12px", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-secondary)", background:"var(--color-background-primary)", color:"var(--color-text-primary)", outline:"none" }}
            />
            <button onClick={handleLookup} disabled={loading || !inputWord.trim()} style={{
              padding:"8px 18px", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-secondary)",
              background: loading||!inputWord.trim() ? "var(--color-background-secondary)" : "var(--color-text-primary)",
              color: loading||!inputWord.trim() ? "var(--color-text-secondary)" : "var(--color-background-primary)",
              cursor: loading||!inputWord.trim() ? "default" : "pointer", fontWeight:500, fontSize:15,
            }}>{loading ? "Looking up…" : "Look Up"}</button>
          </div>

          {error && <p style={{ color:"var(--color-text-danger)", fontSize:14, margin:"0 0 12px" }}>{error}</p>}

          {!previewCard && !loading && (
            <div style={{ border:"0.5px dashed var(--color-border-secondary)", borderRadius:"var(--border-radius-lg)", padding:"2.5rem 1.5rem", textAlign:"center", color:"var(--color-text-tertiary)", fontSize:14 }}>
              <i className="ti ti-vocabulary" style={{ fontSize:32, display:"block", marginBottom:8 }} aria-hidden="true" />
              Type any English word or phrase you don't know — from your textbook, reading, or listening.
            </div>
          )}

          {loading && (
            <div style={{ textAlign:"center", padding:"2.5rem", color:"var(--color-text-secondary)", fontSize:14 }}>
              <i className="ti ti-loader-2" style={{ fontSize:28, display:"block", marginBottom:8, animation:"spin 1s linear infinite" }} aria-hidden="true" />
              Generating definition…
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {previewCard && (
            <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-secondary)", borderRadius:"var(--border-radius-lg)", padding:"1.25rem", marginBottom:12 }}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
                <div>
                  <span style={{ fontSize:20, fontWeight:500 }}>{previewCard.word}</span>
                  <span style={{ fontSize:13, color:"var(--color-text-secondary)", marginLeft:8 }}>{previewCard.partOfSpeech}</span>
                </div>
                <span style={{ fontSize:12, fontWeight:500, background:diffBg[previewCard.difficulty]||"#E1F5EE", color:diffColor[previewCard.difficulty]||"#0F6E56", borderRadius:99, padding:"3px 10px" }}>{previewCard.difficulty}</span>
              </div>
              <p style={{ fontSize:15, margin:"0 0 6px", lineHeight:1.6 }}>{previewCard.definition}</p>
              <p style={{ fontSize:13, color:"var(--color-text-secondary)", margin:"0 0 14px" }}>廣東話參考: <strong style={{ color:"var(--color-text-primary)" }}>{previewCard.cantoneseHint}</strong></p>
              <div style={{ background:"var(--color-background-secondary)", borderRadius:"var(--border-radius-md)", padding:"10px 14px", marginBottom:14 }}>
                <p style={{ fontSize:12, color:"var(--color-text-tertiary)", margin:"0 0 4px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Sample sentence</p>
                <p style={{ fontSize:14, margin:0, lineHeight:1.6, fontStyle:"italic" }}>{previewCard.sampleSentence}</p>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={handleSave} style={{ flex:1, padding:"9px", borderRadius:"var(--border-radius-md)", border:"none", background:"var(--color-text-primary)", color:"var(--color-background-primary)", fontWeight:500, fontSize:14, cursor:"pointer" }}>
                  <i className="ti ti-plus" aria-hidden="true" /> Save to My Vocab
                </button>
                <button onClick={() => { setPreviewCard(null); setInputWord(""); }} style={{ padding:"9px 14px", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-secondary)", background:"none", color:"var(--color-text-secondary)", cursor:"pointer", fontSize:14 }}>Discard</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MY VOCAB ── */}
      {tab === 1 && (
        <div>
          {!vocabList.length ? (
            <div style={{ textAlign:"center", padding:"3rem 1rem", color:"var(--color-text-tertiary)", fontSize:14 }}>
              <i className="ti ti-books" style={{ fontSize:36, display:"block", marginBottom:10 }} aria-hidden="true" />
              No vocab saved yet. Go to Learn and add your first word!
            </div>
          ) : (
            <>
              <p style={{ fontSize:13, color:"var(--color-text-tertiary)", margin:"0 0 12px" }}>Sorted by priority — weak words shown first. Accuracy badge shows quiz history.</p>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {[...vocabList].sort((a,b) => calcWeight(b)-calcWeight(a)).map(v => (
                  <div key={v.id} style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:"var(--border-radius-lg)", padding:"1rem 1.25rem" }}>
                    <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between" }}>
                      <div style={{ flex:1 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:4 }}>
                          <span style={{ fontSize:16, fontWeight:500 }}>{v.word}</span>
                          <span style={{ fontSize:12, color:"var(--color-text-tertiary)" }}>{v.partOfSpeech}</span>
                          <span style={{ fontSize:11, background:diffBg[v.difficulty]||"#E1F5EE", color:diffColor[v.difficulty]||"#0F6E56", borderRadius:99, padding:"2px 8px" }}>{v.difficulty}</span>
                          <SRBadge v={v} />
                        </div>
                        <p style={{ fontSize:13, color:"var(--color-text-secondary)", margin:"0 0 4px" }}>{v.definition}</p>
                        <p style={{ fontSize:12, color:"var(--color-text-tertiary)", margin:0 }}>廣東話: <span style={{ color:"var(--color-text-secondary)" }}>{v.cantoneseHint}</span></p>
                        <p style={{ fontSize:12, color:"var(--color-text-secondary)", margin:"6px 0 0", fontStyle:"italic", lineHeight:1.5 }}>"{v.sampleSentence}"</p>
                      </div>
                      <button onClick={() => handleDelete(v.id)} style={{ marginLeft:12, background:"none", border:"none", cursor:"pointer", color:"var(--color-text-tertiary)", padding:4 }}>
                        <i className="ti ti-trash" style={{ fontSize:16 }} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── DAILY QUIZ ── */}
      {tab === 2 && (
        <div>
          {!vocabList.length && (
            <div style={{ textAlign:"center", padding:"3rem 1rem", color:"var(--color-text-tertiary)", fontSize:14 }}>
              <i className="ti ti-pencil" style={{ fontSize:36, display:"block", marginBottom:10 }} aria-hidden="true" />
              Save at least one word before taking a quiz.
            </div>
          )}

          {vocabList.length > 0 && !quizStarted && (
            <div style={{ textAlign:"center", padding:"2rem 1rem" }}>
              {streak.count > 0 && (
                <div style={{ marginBottom:20 }}>
                  <StreakBadge streak={streak} />
                  <p style={{ fontSize:13, color:"var(--color-text-tertiary)", margin:"8px 0 0" }}>
                    {todayDone ? "Quiz complete for today — come back tomorrow!" : "Don't break your streak — quiz now!"}
                  </p>
                </div>
              )}
              <i className="ti ti-brain" style={{ fontSize:40, display:"block", marginBottom:12, color:"var(--color-text-secondary)" }} aria-hidden="true" />
              <p style={{ fontSize:16, fontWeight:500, margin:"0 0 6px" }}>Daily Fill-in-the-Blank Quiz</p>
              <p style={{ fontSize:14, color:"var(--color-text-secondary)", margin:"0 0 4px" }}>{Math.min(10, vocabList.length)} questions · spaced repetition active</p>
              <p style={{ fontSize:13, color:"var(--color-text-tertiary)", margin:"0 0 20px" }}>Words you struggle with appear more often.</p>
              <button onClick={startQuiz} style={{ padding:"10px 28px", borderRadius:"var(--border-radius-md)", border:"none", background:"var(--color-text-primary)", color:"var(--color-background-primary)", fontWeight:500, fontSize:15, cursor:"pointer" }}>
                {todayDone ? "Practice Again" : "Start Quiz"}
              </button>
            </div>
          )}

          {quizStarted && !quizDone && quiz.length > 0 && (() => {
            const q = quiz[currentQ];
            return (
              <div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                  <span style={{ fontSize:13, color:"var(--color-text-secondary)" }}>Question {currentQ+1} / {quiz.length}</span>
                  <span style={{ fontSize:13, color:"var(--color-text-secondary)" }}>{quiz.filter(x=>x.status==="correct").length} correct</span>
                </div>
                <div style={{ height:3, background:"var(--color-background-secondary)", borderRadius:99, marginBottom:20, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${((currentQ+1)/quiz.length)*100}%`, background:"var(--color-text-primary)", borderRadius:99, transition:"width 0.3s" }} />
                </div>
                <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-secondary)", borderRadius:"var(--border-radius-lg)", padding:"1.5rem" }}>
                  <p style={{ fontSize:12, color:"var(--color-text-tertiary)", margin:"0 0 12px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Fill in the blank</p>
                  <p style={{ fontSize:17, lineHeight:1.9, margin:"0 0 20px", fontStyle:"italic" }}>{q.blankSentence}</p>
                  {!showResult && (
                    <div style={{ display:"flex", gap:8 }}>
                      <input autoFocus value={q.userAnswer}
                        onChange={e => handleAnswer(e.target.value)}
                        onKeyDown={e => e.key==="Enter" && q.userAnswer.trim() && submitAnswer()}
                        placeholder="Type your answer…"
                        style={{ flex:1, fontSize:15, padding:"8px 12px", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-secondary)", background:"var(--color-background-primary)", color:"var(--color-text-primary)", outline:"none" }}
                      />
                      <button onClick={submitAnswer} disabled={!q.userAnswer.trim()} style={{
                        padding:"8px 18px", borderRadius:"var(--border-radius-md)", border:"none",
                        background: q.userAnswer.trim() ? "var(--color-text-primary)" : "var(--color-background-secondary)",
                        color: q.userAnswer.trim() ? "var(--color-background-primary)" : "var(--color-text-tertiary)",
                        fontWeight:500, fontSize:14, cursor: q.userAnswer.trim() ? "pointer" : "default",
                      }}>Check</button>
                    </div>
                  )}
                  {showResult && (
                    <div>
                      <div style={{ borderRadius:"var(--border-radius-md)", padding:"12px 16px", marginBottom:14, background: q.status==="correct" ? "#EAF3DE" : "#FCEBEB", border:`0.5px solid ${q.status==="correct" ? "#97C459" : "#F09595"}` }}>
                        <p style={{ margin:0, fontWeight:500, fontSize:14, color: q.status==="correct" ? "#3B6D11" : "#A32D2D" }}>
                          {q.status==="correct" ? "✓ Correct!" : `✗ The answer is: ${q.word}`}
                        </p>
                        {q.status==="wrong" && <p style={{ margin:"6px 0 0", fontSize:13, color:"#A32D2D" }}>You wrote: {q.userAnswer || "(blank)"}</p>}
                      </div>
                      <p style={{ fontSize:13, color:"var(--color-text-secondary)", margin:"0 0 14px", fontStyle:"italic" }}>Full sentence: {q.sampleSentence}</p>
                      <button onClick={nextQuestion} style={{ width:"100%", padding:"10px", borderRadius:"var(--border-radius-md)", border:"none", background:"var(--color-text-primary)", color:"var(--color-background-primary)", fontWeight:500, fontSize:14, cursor:"pointer" }}>
                        {currentQ+1 < quiz.length ? "Next →" : "See Results"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {quizDone && quiz.length > 0 && (
            <div style={{ textAlign:"center", padding:"1rem 0" }}>
              <div style={{ fontSize:48, marginBottom:8 }}>{score===quiz.length ? "🏆" : score>=quiz.length*0.7 ? "👏" : "📚"}</div>
              <p style={{ fontSize:22, fontWeight:500, margin:"0 0 4px" }}>{score} / {quiz.length}</p>
              <p style={{ fontSize:14, color:"var(--color-text-secondary)", margin:"0 0 16px" }}>
                {score===quiz.length ? "Perfect score! Outstanding!" : score>=quiz.length*0.7 ? "Great effort! Keep it up." : "Keep reviewing — you'll improve!"}
              </p>
              <div style={{ marginBottom:8 }}><StreakBadge streak={streak} /></div>
              <p style={{ fontSize:13, color:"var(--color-text-tertiary)", margin:"0 0 20px" }}>Wrong answers will appear more often in tomorrow's quiz.</p>
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:24, textAlign:"left" }}>
                {quiz.map((q,i) => (
                  <div key={q.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-tertiary)", background: q.status==="correct" ? "#EAF3DE" : "#FCEBEB" }}>
                    <span style={{ fontSize:13, fontWeight:500, minWidth:18, color: q.status==="correct" ? "#3B6D11" : "#A32D2D" }}>{i+1}.</span>
                    <span style={{ fontSize:14, fontWeight:500, flex:1, color: q.status==="correct" ? "#3B6D11" : "#A32D2D" }}>{q.word}</span>
                    <i className={`ti ti-${q.status==="correct" ? "check" : "x"}`} style={{ fontSize:16, color: q.status==="correct" ? "#3B6D11" : "#A32D2D" }} aria-hidden="true" />
                  </div>
                ))}
              </div>
              <button onClick={startQuiz} style={{ padding:"10px 24px", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-secondary)", background:"none", color:"var(--color-text-primary)", fontWeight:500, fontSize:14, cursor:"pointer" }}>
                <i className="ti ti-refresh" aria-hidden="true" /> Practice Again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

