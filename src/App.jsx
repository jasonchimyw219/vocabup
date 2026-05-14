import { useState, useEffect, useCallback } from "react";

// ── Replace this with your Cloudflare Worker URL ──────────────────────────────
const WORKER_URL = "https://vocabup-proxy.jasonchimyw.workers.dev/";
// ─────────────────────────────────────────────────────────────────────────────

// ── Storage: uses localStorage (works in any browser) ────────────────────────
const storage = {
  get: (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch(_) { return null; } },
  set: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch(_) {} },
};

const SK = {
  vocab:    "hkdse_vocab_list",
  quiz:     "hkdse_quiz_state",
  lastQuiz: "hkdse_last_quiz_date",
  streak:   "hkdse_streak",
};

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

async function fetchWordData(word) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word }),
  });
  const data = await res.json();
  return JSON.parse(data.text.replace(/```json|```/g, "").trim());
}

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
  if (shown === 0) return <span style={{ fontSize:11, color:"#888" }}>New</span>;
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
  const [streak, setStreak]           = useState({ count:0, lastDate:"" });

  // ── Load from localStorage on startup ──
  useEffect(() => {
    const savedVocab  = storage.get(SK.vocab);
    const savedStreak = storage.get(SK.streak);
    if (savedVocab)  setVocabList(savedVocab);
    if (savedStreak) setStreak(savedStreak);
  }, []);

  // ── Save vocab whenever it changes ──
  useEffect(() => {
    storage.set(SK.vocab, vocabList);
  }, [vocabList]);

  // ── Save streak whenever it changes ──
  useEffect(() => {
    storage.set(SK.streak, streak);
  }, [streak]);

  // ── Load/build quiz when entering quiz tab ──
  useEffect(() => {
    if (tab !== 2 || !vocabList.length) return;
    const lastDate  = storage.get(SK.lastQuiz);
    const savedQuiz = storage.get(SK.quiz);
    const today     = getTodayStr();
    if (lastDate === today && savedQuiz) {
      setQuiz(savedQuiz);
      const allDone = savedQuiz.every(q => q.status !== "unanswered");
      setQuizStarted(true); setQuizDone(allDone);
      const first = savedQuiz.findIndex(q => q.status === "unanswered");
      setCurrentQ(first === -1 ? savedQuiz.length - 1 : first);
    } else {
      setQuiz(buildQuiz(vocabList)); setQuizStarted(false); setQuizDone(false); setCurrentQ(0);
    }
  }, [tab, vocabList]);

  const saveQuiz = useCallback((q) => {
    storage.set(SK.quiz, q);
    storage.set(SK.lastQuiz, getTodayStr());
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

  // ── Styles ──
  const card = { background:"#fff", border:"0.5px solid #e0e0e0", borderRadius:12, padding:"1rem 1.25rem" };
  const btn  = { borderRadius:8, fontWeight:500, fontSize:14, cursor:"pointer", padding:"9px 18px" };

  return (
    <div style={{ fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth:640, margin:"0 auto", padding:"1.5rem 1rem", background:"#f9f9f7", minHeight:"100vh" }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1.5rem", flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
            <span style={{ fontSize:22, fontWeight:600, color:"#111" }}>VocabUp</span>
            <span style={{ fontSize:13, color:"#666", background:"#eee", borderRadius:99, padding:"2px 10px" }}>HKDSE F4–6</span>
          </div>
          <p style={{ fontSize:14, color:"#666", margin:"4px 0 0" }}>Build vocabulary. Train memory. Ace the exam.</p>
        </div>
        <StreakBadge streak={streak} />
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:4, marginBottom:"1.5rem", borderBottom:"1px solid #e0e0e0" }}>
        {TABS.map((t,i) => (
          <button key={t} onClick={() => setTab(i)} style={{
            background:"none", border:"none",
            borderBottom: tab===i ? "2px solid #111" : "2px solid transparent",
            color: tab===i ? "#111" : "#888",
            fontWeight: tab===i ? 600 : 400, fontSize:15, padding:"8px 14px", cursor:"pointer", borderRadius:0,
            display:"flex", alignItems:"center", gap:6,
          }}>
            {i===2 && quizStarted && !quizDone && <span style={{ width:7, height:7, borderRadius:"50%", background:"#E24B4A", display:"inline-block" }} />}
            {t}
            {i===1 && vocabList.length > 0 && <span style={{ fontSize:11, background:"#eee", borderRadius:99, padding:"1px 7px" }}>{vocabList.length}</span>}
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
              style={{ flex:1, fontSize:15, padding:"9px 12px", borderRadius:8, border:"1px solid #ccc", outline:"none", background:"#fff" }}
            />
            <button onClick={handleLookup} disabled={loading || !inputWord.trim()} style={{
              ...btn,
              background: loading||!inputWord.trim() ? "#eee" : "#111",
              color: loading||!inputWord.trim() ? "#aaa" : "#fff",
              border:"none",
              cursor: loading||!inputWord.trim() ? "default" : "pointer",
            }}>{loading ? "Looking up…" : "Look Up"}</button>
          </div>

          {error && <p style={{ color:"#c0392b", fontSize:14, margin:"0 0 12px" }}>{error}</p>}

          {!previewCard && !loading && (
            <div style={{ border:"1.5px dashed #ccc", borderRadius:12, padding:"2.5rem 1.5rem", textAlign:"center", color:"#aaa", fontSize:14 }}>
              Type any English word or phrase you don't know — from your textbook, reading, or listening.
            </div>
          )}

          {loading && (
            <div style={{ textAlign:"center", padding:"2.5rem", color:"#888", fontSize:14 }}>
              <div style={{ fontSize:28, marginBottom:8, animation:"spin 1s linear infinite", display:"inline-block" }}>⏳</div>
              <div>Generating definition…</div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {previewCard && (
            <div style={card}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
                <div>
                  <span style={{ fontSize:20, fontWeight:600, color:"#111" }}>{previewCard.word}</span>
                  <span style={{ fontSize:13, color:"#888", marginLeft:8 }}>{previewCard.partOfSpeech}</span>
                </div>
                <span style={{ fontSize:12, fontWeight:500, background:diffBg[previewCard.difficulty]||"#E1F5EE", color:diffColor[previewCard.difficulty]||"#0F6E56", borderRadius:99, padding:"3px 10px" }}>{previewCard.difficulty}</span>
              </div>
              <p style={{ fontSize:15, margin:"0 0 6px", lineHeight:1.6, color:"#222" }}>{previewCard.definition}</p>
              <p style={{ fontSize:13, color:"#666", margin:"0 0 14px" }}>廣東話參考: <strong style={{ color:"#111" }}>{previewCard.cantoneseHint}</strong></p>
              <div style={{ background:"#f5f5f3", borderRadius:8, padding:"10px 14px", marginBottom:14 }}>
                <p style={{ fontSize:11, color:"#aaa", margin:"0 0 4px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Sample sentence</p>
                <p style={{ fontSize:14, margin:0, lineHeight:1.6, fontStyle:"italic", color:"#333" }}>{previewCard.sampleSentence}</p>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={handleSave} style={{ ...btn, flex:1, border:"none", background:"#111", color:"#fff" }}>
                  + Save to My Vocab
                </button>
                <button onClick={() => { setPreviewCard(null); setInputWord(""); }} style={{ ...btn, border:"1px solid #ccc", background:"#fff", color:"#666" }}>Discard</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MY VOCAB ── */}
      {tab === 1 && (
        <div>
          {!vocabList.length ? (
            <div style={{ textAlign:"center", padding:"3rem 1rem", color:"#aaa", fontSize:14 }}>
              No vocab saved yet. Go to Learn and add your first word!
            </div>
          ) : (
            <>
              <p style={{ fontSize:13, color:"#aaa", margin:"0 0 12px" }}>Sorted by priority — weak words shown first. Accuracy badge shows quiz history.</p>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {[...vocabList].sort((a,b) => calcWeight(b)-calcWeight(a)).map(v => (
                  <div key={v.id} style={card}>
                    <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between" }}>
                      <div style={{ flex:1 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:4 }}>
                          <span style={{ fontSize:16, fontWeight:600, color:"#111" }}>{v.word}</span>
                          <span style={{ fontSize:12, color:"#aaa" }}>{v.partOfSpeech}</span>
                          <span style={{ fontSize:11, background:diffBg[v.difficulty]||"#E1F5EE", color:diffColor[v.difficulty]||"#0F6E56", borderRadius:99, padding:"2px 8px" }}>{v.difficulty}</span>
                          <SRBadge v={v} />
                        </div>
                        <p style={{ fontSize:13, color:"#555", margin:"0 0 4px" }}>{v.definition}</p>
                        <p style={{ fontSize:12, color:"#aaa", margin:0 }}>廣東話: <span style={{ color:"#666" }}>{v.cantoneseHint}</span></p>
                        <p style={{ fontSize:12, color:"#666", margin:"6px 0 0", fontStyle:"italic", lineHeight:1.5 }}>"{v.sampleSentence}"</p>
                      </div>
                      <button onClick={() => handleDelete(v.id)} style={{ marginLeft:12, background:"none", border:"none", cursor:"pointer", color:"#ccc", fontSize:18, padding:4 }}>🗑</button>
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
            <div style={{ textAlign:"center", padding:"3rem 1rem", color:"#aaa", fontSize:14 }}>
              Save at least one word before taking a quiz.
            </div>
          )}

          {vocabList.length > 0 && !quizStarted && (
            <div style={{ textAlign:"center", padding:"2rem 1rem" }}>
              {streak.count > 0 && (
                <div style={{ marginBottom:20 }}>
                  <StreakBadge streak={streak} />
                  <p style={{ fontSize:13, color:"#aaa", margin:"8px 0 0" }}>
                    {todayDone ? "Quiz complete for today — come back tomorrow!" : "Don't break your streak — quiz now!"}
                  </p>
                </div>
              )}
              <div style={{ fontSize:40, marginBottom:12 }}>🧠</div>
              <p style={{ fontSize:16, fontWeight:600, margin:"0 0 6px", color:"#111" }}>Daily Fill-in-the-Blank Quiz</p>
              <p style={{ fontSize:14, color:"#666", margin:"0 0 4px" }}>{Math.min(10, vocabList.length)} questions · spaced repetition active</p>
              <p style={{ fontSize:13, color:"#aaa", margin:"0 0 20px" }}>Words you struggle with appear more often.</p>
              <button onClick={startQuiz} style={{ ...btn, border:"none", background:"#111", color:"#fff", fontSize:15, padding:"10px 28px" }}>
                {todayDone ? "Practice Again" : "Start Quiz"}
              </button>
            </div>
          )}

          {quizStarted && !quizDone && quiz.length > 0 && (() => {
            const q = quiz[currentQ];
            return (
              <div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                  <span style={{ fontSize:13, color:"#888" }}>Question {currentQ+1} / {quiz.length}</span>
                  <span style={{ fontSize:13, color:"#888" }}>{quiz.filter(x=>x.status==="correct").length} correct</span>
                </div>
                <div style={{ height:4, background:"#eee", borderRadius:99, marginBottom:20, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${((currentQ+1)/quiz.length)*100}%`, background:"#111", borderRadius:99, transition:"width 0.3s" }} />
                </div>
                <div style={card}>
                  <p style={{ fontSize:11, color:"#aaa", margin:"0 0 12px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Fill in the blank</p>
                  <p style={{ fontSize:17, lineHeight:1.9, margin:"0 0 20px", fontStyle:"italic", color:"#222" }}>{q.blankSentence}</p>
                  {!showResult && (
                    <div style={{ display:"flex", gap:8 }}>
                      <input autoFocus value={q.userAnswer}
                        onChange={e => handleAnswer(e.target.value)}
                        onKeyDown={e => e.key==="Enter" && q.userAnswer.trim() && submitAnswer()}
                        placeholder="Type your answer…"
                        style={{ flex:1, fontSize:15, padding:"9px 12px", borderRadius:8, border:"1px solid #ccc", outline:"none", background:"#fff" }}
                      />
                      <button onClick={submitAnswer} disabled={!q.userAnswer.trim()} style={{
                        ...btn, border:"none",
                        background: q.userAnswer.trim() ? "#111" : "#eee",
                        color: q.userAnswer.trim() ? "#fff" : "#aaa",
                        cursor: q.userAnswer.trim() ? "pointer" : "default",
                      }}>Check</button>
                    </div>
                  )}
                  {showResult && (
                    <div>
                      <div style={{ borderRadius:8, padding:"12px 16px", marginBottom:14, background: q.status==="correct" ? "#EAF3DE" : "#FCEBEB", border:`1px solid ${q.status==="correct" ? "#97C459" : "#F09595"}` }}>
                        <p style={{ margin:0, fontWeight:600, fontSize:14, color: q.status==="correct" ? "#3B6D11" : "#A32D2D" }}>
                          {q.status==="correct" ? "✓ Correct!" : `✗ The answer is: ${q.word}`}
                        </p>
                        {q.status==="wrong" && <p style={{ margin:"6px 0 0", fontSize:13, color:"#A32D2D" }}>You wrote: {q.userAnswer || "(blank)"}</p>}
                      </div>
                      <p style={{ fontSize:13, color:"#666", margin:"0 0 14px", fontStyle:"italic" }}>Full sentence: {q.sampleSentence}</p>
                      <button onClick={nextQuestion} style={{ ...btn, width:"100%", border:"none", background:"#111", color:"#fff" }}>
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
              <p style={{ fontSize:22, fontWeight:600, margin:"0 0 4px", color:"#111" }}>{score} / {quiz.length}</p>
              <p style={{ fontSize:14, color:"#666", margin:"0 0 16px" }}>
                {score===quiz.length ? "Perfect score! Outstanding!" : score>=quiz.length*0.7 ? "Great effort! Keep it up." : "Keep reviewing — you'll improve!"}
              </p>
              <div style={{ marginBottom:8 }}><StreakBadge streak={streak} /></div>
              <p style={{ fontSize:13, color:"#aaa", margin:"0 0 20px" }}>Wrong answers will appear more often in tomorrow's quiz.</p>
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:24, textAlign:"left" }}>
                {quiz.map((q,i) => (
                  <div key={q.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", borderRadius:8, border:"1px solid #eee", background: q.status==="correct" ? "#EAF3DE" : "#FCEBEB" }}>
                    <span style={{ fontSize:13, fontWeight:600, minWidth:18, color: q.status==="correct" ? "#3B6D11" : "#A32D2D" }}>{i+1}.</span>
                    <span style={{ fontSize:14, fontWeight:500, flex:1, color: q.status==="correct" ? "#3B6D11" : "#A32D2D" }}>{q.word}</span>
                    <span style={{ fontSize:16 }}>{q.status==="correct" ? "✓" : "✗"}</span>
                  </div>
                ))}
              </div>
              <button onClick={startQuiz} style={{ ...btn, border:"1px solid #ccc", background:"#fff", color:"#111" }}>
                ↺ Practice Again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
