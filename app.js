"use strict";

// ---------- Storage ----------
// 単語リストの中身は GitHub 上の lists/*.md が正。
// 端末ごとの状態(選択中のリスト・不正解/正解カウンタ・設定)だけを localStorage に持つ。

const SELECTED_KEY = "tanolist-selected-v1";
const COUNTERS_KEY = "tanolist-counters-v1";
const MEDALS_KEY = "tanolist-medals-v1";
const SETTINGS_KEY = "tanolist-settings-v1";

const LISTS_DIR = "lists";

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 容量超過やプライベートモードでは保存できないが、アプリは動かし続ける
  }
}

/** @type {{feedbackSec: number, speech: boolean, speechRate: number}} */
const settings = { feedbackSec: 1.0, speech: true, speechRate: 0.9, ...loadJson(SETTINGS_KEY, {}) };

/** 不正解カウンタ: { [ファイル名]: { [単語\t対訳]: 回数 } } */
const counters = loadJson(COUNTERS_KEY, {});
/** 正解カウンタ(メダル): 同じ形。不正解カウンタが 0 のときだけ 1 以上になる */
const medals = loadJson(MEDALS_KEY, {});

const MAX_MEDALS = 3;

const pairKey = (pair) => `${pair.word}\t${pair.meaning}`;

function getCounter(file, pair) {
  return counters[file]?.[pairKey(pair)] ?? 0;
}

function getMedals(file, pair) {
  return medals[file]?.[pairKey(pair)] ?? 0;
}

function setCount(store, storageKey, file, pair, value) {
  const bucket = (store[file] ??= {});
  const key = pairKey(pair);
  if (value === 0) delete bucket[key];
  else bucket[key] = value;
  saveJson(storageKey, store);
}

/**
 * 回答結果でカウンタを動かす。2 つのカウンタは 1 本の目盛りとしてつながっている:
 *   不正解 …2 → 1 → 0 ⇄ 正解 1 → 2 → 3(上限)
 * 正解なら右へ、不正解なら左へ 1 つ進む。
 */
function recordAnswer(file, pair, isCorrect) {
  const wrong = getCounter(file, pair);
  const medal = getMedals(file, pair);
  if (isCorrect) {
    if (wrong > 0) setCount(counters, COUNTERS_KEY, file, pair, wrong - 1);
    else setCount(medals, MEDALS_KEY, file, pair, Math.min(MAX_MEDALS, medal + 1));
  } else {
    if (medal > 0) setCount(medals, MEDALS_KEY, file, pair, medal - 1);
    else setCount(counters, COUNTERS_KEY, file, pair, wrong + 1);
  }
}

// ---------- Word list files ----------

/** @typedef {{word: string, meaning: string}} Pair */
/** @typedef {{file: string, name: string, lang: string|null, pairs: Pair[]}} WordList */

/**
 * 1 行目付近の「# 名前」をリスト名、それ以降の「単語 : 対訳」を 1 ペアとして読む。
 * 区切りは「:」「：」「|」「=」タブのどれでもよい。先頭の「- 」やテーブルの「|」は無視する。
 * 「lang: ko-KR」の行があれば、単語側の読み上げ言語として使う。
 */
function parseList(text, file) {
  let name = null;
  let lang = null;
  const pairs = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (name === null) name = line.replace(/^#+\s*/, "");
      continue;
    }
    const langLine = line.match(/^lang\s*[:：]\s*([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)$/i);
    if (langLine) {
      lang = langLine[1].replace("_", "-");
      continue;
    }
    if (/^\|?[\s:|-]+$/.test(line)) continue; // テーブルの区切り行
    line = line.replace(/^([-*+]|\d+[.)])\s+/, "").replace(/^\|/, "").replace(/\|$/, "");
    const m = line.match(/^(.+?)\s*(?:\||\t|：|:|=)\s*(.+)$/);
    if (!m) continue;
    const word = m[1].trim();
    const meaning = m[2].trim();
    if (word && meaning) pairs.push({ word, meaning });
  }
  return { file, name: name || file.replace(/\.md$/, ""), lang, pairs };
}

async function fetchList(file) {
  const res = await fetch(`${LISTS_DIR}/${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(`${file} を読み込めませんでした (${res.status})`);
  return parseList(await res.text(), file);
}

/** GitHub Pages 上なら { owner, repo } を返す */
function githubRepo() {
  const host = location.hostname;
  if (!host.endsWith(".github.io")) return null;
  const owner = host.split(".")[0];
  const firstSegment = location.pathname.split("/").filter(Boolean)[0];
  const repo = firstSegment && !firstSegment.includes(".") ? firstSegment : host;
  return { owner, repo };
}

/**
 * lists/ にある .md ファイル名の一覧。
 * GitHub Pages ではフォルダ一覧が取れないので GitHub API で走査し、
 * 使えない場合(ローカル確認時・API 制限時)は lists/index.json を使う。
 */
async function fetchListFileNames() {
  const gh = githubRepo();
  if (gh) {
    try {
      const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${LISTS_DIR}`);
      if (res.ok) {
        const items = await res.json();
        return items.filter((it) => it.type === "file" && it.name.endsWith(".md")).map((it) => it.name);
      }
    } catch {
      // 下の index.json にフォールバック
    }
  }
  const res = await fetch(`${LISTS_DIR}/index.json`);
  if (!res.ok) throw new Error("単語リストの一覧を取得できませんでした");
  return res.json();
}

// ---------- Speech ----------
// ブラウザ内蔵の読み上げ(Web Speech API)で単語側を読む。iPhone なら韓国語・日本語の音声が標準で入っている。

const canSpeak = "speechSynthesis" in window;

/** lang 指定が無いリスト用に、文字の種類から読み上げ言語を推測する */
function detectLang(text) {
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(text)) return "ko-KR";
  if (/[\u3040-\u30ff]/.test(text)) return "ja-JP";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh-CN";
  if (/[A-Za-z]/.test(text)) return "en-US";
  return null;
}

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices();
  const norm = (v) => v.lang.replace("_", "-").toLowerCase();
  const want = lang.toLowerCase();
  return (
    voices.find((v) => norm(v) === want) ||
    voices.find((v) => norm(v).split("-")[0] === want.split("-")[0]) ||
    null
  );
}

/** 端末にその言語の音声が入っていないことが確定しているか(一覧を読み込み中なら false) */
function voiceMissing(lang) {
  return !!lang && speechSynthesis.getVoices().length > 0 && !pickVoice(lang);
}

/** Chrome では再生中の発話オブジェクトが GC されると onend が来なくなるので参照を持っておく */
let currentUtterance = null;

/** 読み上げが終わったら resolve する。読み上げない・読めないときはすぐ resolve */
function speak(text, lang) {
  return new Promise((resolve) => {
    if (!canSpeak || !settings.speech || !lang) return resolve();
    // その言語の音声が無いと既定の音声(日本語など)で代読されてしまうので、読まない
    if (voiceMissing(lang)) return resolve();
    // Chrome は cancel() 直後の speak() を捨てることがあるので、読み上げ中のときだけ止める
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    currentUtterance = u;
    u.lang = lang;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.rate = settings.speechRate;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    setTimeout(finish, 6000); // iOS では onend が来ないことがあるので保険
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  if (canSpeak) speechSynthesis.cancel();
}

/** 使用中リストの単語側の読み上げ言語 */
const listLang = () => currentList.lang || detectLang(currentList.pairs[0]?.word ?? "");

const speakWord = (pair) => speak(pair.word, currentList.lang || detectLang(pair.word));

// ---------- Utils ----------

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const $ = (id) => document.getElementById(id);

// ---------- State ----------

/** @type {WordList|null} */
let currentList = null;
/** @type {"word"|"meaning"} word = 覚える単語を出題 / meaning = 日本語を出題 */
let direction = "word";

/**
 * @type {{
 *   mode: string, questions: Pair[], index: number,
 *   correct: number, wrong: number, missed: Pair[], token: number
 * }|null}
 */
let quiz = null;
let quizToken = 0;

// ---------- Screens ----------

const SCREENS = ["Menu", "Select", "Modes", "Quiz", "Result", "Settings"];

function show(name) {
  for (const s of SCREENS) $(`screen${s}`).hidden = s !== name;
  $("homeBtn").hidden = name === "Menu";
  $("modeTitle").hidden = name !== "Quiz" && name !== "Result";
  window.scrollTo(0, 0);
}

function setStatus(el, text, isError = false) {
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("error", isError);
}

function renderMenu() {
  const hasList = !!currentList && currentList.pairs.length > 0;
  $("currentListName").textContent = currentList ? currentList.name : "未選択";
  $("currentListMeta").textContent = currentList
    ? `${currentList.pairs.length} 語 ・ 苦手 ${wrongPairs().length} 語`
    : "まずは「単語リストを選択」から選んでください";
  for (const btn of document.querySelectorAll(".needs-list")) btn.disabled = !hasList;
  show("Menu");
}

function wrongPairs() {
  if (!currentList) return [];
  return currentList.pairs.filter((p) => getCounter(currentList.file, p) >= 1);
}

// ---------- List select ----------

async function openSelect() {
  show("Select");
  const ul = $("listChoices");
  ul.innerHTML = "";
  setStatus($("selectStatus"), "単語リストを読み込み中…");
  try {
    const files = await fetchListFileNames();
    const lists = await Promise.all(files.map((f) => fetchList(f).catch(() => null)));
    const valid = lists.filter(Boolean);
    setStatus($("selectStatus"), valid.length ? "" : "単語リストが見つかりませんでした", !valid.length);
    for (const list of valid) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "choice" + (currentList?.file === list.file ? " active" : "");
      const name = document.createElement("span");
      name.textContent = list.name;
      const meta = document.createElement("span");
      meta.className = "choice-meta";
      meta.textContent = `${list.pairs.length} 語`;
      btn.append(name, meta);
      btn.addEventListener("click", () => {
        currentList = list;
        saveJson(SELECTED_KEY, list.file);
        renderMenu();
      });
      li.append(btn);
      ul.append(li);
    }
  } catch (err) {
    setStatus($("selectStatus"), err.message, true);
  }
}

// ---------- Quiz ----------

const DIRECTION_LABELS = { word: "出題（覚える単語側）", meaning: "出題（日本語側）" };
const MODE_LABELS = { order: "順番に出題", random: "ランダムに出題", wrong: "間違いのみ出題" };

function openModes(dir) {
  direction = dir;
  $("modesTitle").textContent = DIRECTION_LABELS[dir];
  const n = wrongPairs().length;
  $("wrongCount").textContent = n ? `不正解カウンタ 1 以上の ${n} 語` : "間違えた単語はまだありません";
  document.querySelector('[data-mode="wrong"]').disabled = n === 0;
  show("Modes");
}

function startQuiz(mode) {
  const pairs = currentList.pairs;
  let questions;
  if (mode === "random") questions = shuffle(pairs);
  else if (mode === "wrong") questions = wrongPairs();
  else questions = pairs.slice();
  if (!questions.length) return;

  quiz = { mode, questions, index: 0, correct: 0, wrong: 0, missed: [], token: ++quizToken };
  $("modeTitleDir").textContent = DIRECTION_LABELS[direction];
  $("modeTitleMode").textContent = MODE_LABELS[mode];
  show("Quiz");
  renderQuestion();
}

const promptOf = (pair) => (direction === "word" ? pair.word : pair.meaning);
const answerOf = (pair) => (direction === "word" ? pair.meaning : pair.word);

function renderQuestion() {
  const pair = quiz.questions[quiz.index];
  const answer = answerOf(pair);

  // 不正解の選択肢: 使用中リスト全体から、正解と同じ表記にならないものを 3 つ
  const distractors = [];
  for (const p of shuffle(currentList.pairs)) {
    const text = answerOf(p);
    if (text !== answer && !distractors.includes(text)) distractors.push(text);
    if (distractors.length === 3) break;
  }
  const options = shuffle([answer, ...distractors]);

  $("quizProgress").textContent = `${quiz.index + 1} / ${quiz.questions.length}`;
  updateCounterLabel(pair);
  $("quizPrompt").textContent = promptOf(pair);

  const box = $("quizOptions");
  box.innerHTML = "";
  for (const text of options) {
    const btn = document.createElement("button");
    btn.className = "option";
    btn.textContent = text;
    btn.addEventListener("click", () => answerQuestion(btn, text === answer));
    box.append(btn);
  }
}

function updateCounterLabel(pair) {
  const n = getCounter(currentList.file, pair);
  $("quizCounter").textContent = `×:${n}回`;
  $("quizCounter").classList.toggle("has-miss", n > 0);
  const m = getMedals(currentList.file, pair);
  $("quizMedals").textContent = "🏅".repeat(m);
  $("quizMedals").setAttribute("aria-label", `正解カウンタ ${m}`);
}

function answerQuestion(clicked, isCorrect) {
  const pair = quiz.questions[quiz.index];
  const answer = answerOf(pair);
  for (const btn of $("quizOptions").children) {
    btn.disabled = true;
    if (btn.textContent === answer) btn.classList.add("correct");
  }
  if (isCorrect) {
    quiz.correct++;
    recordAnswer(currentList.file, pair, true);
  } else {
    clicked.classList.add("wrong");
    quiz.wrong++;
    quiz.missed.push(pair);
    recordAnswer(currentList.file, pair, false);
  }
  updateCounterLabel(pair);
  showMark(isCorrect);

  // 読み上げは出題の向きに関係なく常に単語側。○×を出し終えて、かつ読み終えてから次へ進む
  const token = quiz.token;
  const spoken = speakWord(pair);
  const marked = new Promise((r) => setTimeout(r, settings.feedbackSec * 1000)).then(hideMark);
  Promise.all([spoken, marked]).then(() => {
    if (!quiz || quiz.token !== token) return; // 途中で中断された
    quiz.index++;
    if (quiz.index < quiz.questions.length) renderQuestion();
    else showResult();
  });
}

function showMark(ok) {
  // SVG 要素には hidden プロパティが無いので属性を直接切り替える
  $("markCircle").toggleAttribute("hidden", !ok);
  $("markCross").toggleAttribute("hidden", ok);
  $("markOverlay").hidden = false;
}

function hideMark() {
  $("markOverlay").hidden = true;
}

function showResult() {
  $("resultCorrect").textContent = quiz.correct;
  $("resultWrong").textContent = quiz.wrong;
  const ul = $("resultMissed");
  ul.innerHTML = "";
  for (const p of quiz.missed) {
    const li = document.createElement("li");
    const w = document.createElement("span");
    w.textContent = p.word;
    const m = document.createElement("span");
    m.className = "missed-meaning";
    m.textContent = p.meaning;
    li.append(w, m);
    ul.append(li);
  }
  $("resultMissedWrap").hidden = quiz.missed.length === 0;
  show("Result");
}

function quitQuiz() {
  quiz = null;
  stopSpeaking();
  hideMark();
  renderMenu();
}

// ---------- Settings ----------

function openSettings() {
  $("feedbackSec").value = settings.feedbackSec;
  $("feedbackSecLabel").textContent = settings.feedbackSec.toFixed(1);
  $("speechOn").checked = settings.speech;
  $("speechRate").value = settings.speechRate;
  $("speechRateLabel").textContent = settings.speechRate.toFixed(1);
  renderSpeechNote();
  for (const id of ["speechOn", "speechRate", "speechTestBtn"]) $(id).disabled = !canSpeak;
  $("speechTestBtn").disabled = !canSpeak || !currentList?.pairs.length;
  $("resetCountersBtn").disabled = !currentList;
  show("Settings");
}

function renderSpeechNote() {
  let note = "";
  if (!canSpeak) note = "このブラウザは読み上げに対応していません。";
  else if (currentList && voiceMissing(listLang())) {
    note = `この端末には「${listLang()}」の読み上げ音声が入っていないため、音が出ません。`;
  }
  $("speechNote").textContent = note;
  $("speechNote").hidden = !note;
}

// 音声の一覧は後から読み込まれることがあるので、そのときに注意書きを更新する
if (canSpeak) {
  speechSynthesis.addEventListener("voiceschanged", () => {
    if (!$("screenSettings").hidden) renderSpeechNote();
  });
}

// ---------- Events ----------

$("homeBtn").addEventListener("click", quitQuiz);
$("quitQuizBtn").addEventListener("click", quitQuiz);
$("backMenuBtn").addEventListener("click", quitQuiz);
$("retryBtn").addEventListener("click", () => {
  const mode = quiz.mode;
  if (mode === "wrong" && wrongPairs().length === 0) {
    quitQuiz();
    return;
  }
  startQuiz(mode);
});

for (const btn of document.querySelectorAll("[data-go]")) {
  btn.addEventListener("click", () => {
    const go = btn.dataset.go;
    if (go === "select") openSelect();
    else if (go === "modes") openModes(btn.dataset.dir);
    else if (go === "settings") openSettings();
  });
}

for (const btn of document.querySelectorAll("[data-mode]")) {
  btn.addEventListener("click", () => startQuiz(btn.dataset.mode));
}

$("feedbackSec").addEventListener("input", (e) => {
  settings.feedbackSec = Number(e.target.value);
  $("feedbackSecLabel").textContent = settings.feedbackSec.toFixed(1);
  saveJson(SETTINGS_KEY, settings);
});

$("speechOn").addEventListener("change", (e) => {
  settings.speech = e.target.checked;
  saveJson(SETTINGS_KEY, settings);
});

$("speechRate").addEventListener("input", (e) => {
  settings.speechRate = Number(e.target.value);
  $("speechRateLabel").textContent = settings.speechRate.toFixed(1);
  saveJson(SETTINGS_KEY, settings);
});

$("speechTestBtn").addEventListener("click", () => {
  const pairs = currentList.pairs;
  const pair = pairs[Math.floor(Math.random() * pairs.length)];
  // オフ設定でもお試しは鳴らす
  const saved = settings.speech;
  settings.speech = true;
  speakWord(pair);
  settings.speech = saved;
});

$("resetCountersBtn").addEventListener("click", () => {
  if (!currentList) return;
  if (!confirm(`「${currentList.name}」の不正解カウンタと正解カウンタをすべて 0 に戻しますか？`)) return;
  delete counters[currentList.file];
  delete medals[currentList.file];
  saveJson(COUNTERS_KEY, counters);
  saveJson(MEDALS_KEY, medals);
  renderMenu();
});

// ---------- Boot ----------

async function boot() {
  renderMenu();
  const file = loadJson(SELECTED_KEY, null);
  if (!file) return;
  setStatus($("statusMsg"), "単語リストを読み込み中…");
  try {
    currentList = await fetchList(file);
    setStatus($("statusMsg"), "");
  } catch (err) {
    setStatus($("statusMsg"), `${err.message}。リストを選び直してください。`, true);
  }
  renderMenu();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
