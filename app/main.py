import os, datetime, secrets, random, json
from datetime import date
from fastapi import FastAPI, Depends, HTTPException, Response, Request, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import httpx
from sqlmodel import SQLModel, Field, create_engine, Session, select
from sqlalchemy import delete
from itsdangerous import URLSafeSerializer, BadSignature
import bcrypt
from pathlib import Path
from dotenv import load_dotenv
from typing import Optional, Tuple, List, Dict
from urllib.parse import urlencode

ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")

DB_URL = os.getenv("DB_URL", f"sqlite:///{(ROOT_DIR/'app.db').as_posix()}")
SECRET = os.getenv("SECRET", "devsecret")

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://127.0.0.1:8000/auth/google/callback")
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

oauth_signer = URLSafeSerializer(SECRET, salt="oauth")

_CACHE: List[Dict] = []
_CACHE_MTIME: float = 0.0

WORDBANK = "data/word.json"

def _load_wordbank() -> List[Dict]:
    global _CACHE, _CACHE_MTIME
    p = Path(WORDBANK)
    if not p.exists():
        return []
    mtime = p.stat().st_mtime
    if _CACHE and _CACHE_MTIME == mtime:
        return _CACHE

    if p.suffix.lower() == ".json":
        items = json.loads(p.read_text("utf-8"))
    else:
        try:
            items = []
        except Exception:
            items = []

    normed: List[Dict] = []
    for it in items:
        w = (it.get("word") or it.get("Word") or "").strip()
        tr = it.get("translation") or it.get("Translation") or ""
        if isinstance(tr, list):
            translations = [str(x).strip() for x in tr if str(x).strip()]
        else:
            raw = str(tr).strip()
            if "||" in raw:
                translations = [x.strip() for x in raw.split("||") if x.strip()]
            elif "|" in raw:
                translations = [x.strip() for x in raw.split("|") if x.strip()]
            else:
                translations = [raw] if raw else []
        if not w or not translations:
            continue
        normed.append({"word": w, "translation": translations})

    _CACHE = normed
    _CACHE_MTIME = mtime
    return _CACHE

def get_random_word_and_meaning(used_words: set[str]) -> Optional[Tuple[str, str]]:
    items = _load_wordbank()
    if not items:
        return None

    used_lower = set((u or "").lower() for u in used_words)
    pool = []
    for it in items:
        w = (it.get("word") or "").strip()
        if not w or w.lower() in used_lower:
            continue
        pool.append(it)
    if not pool:
        return None
    pick = random.choice(pool)
    translations = pick.get("translation") or []
    if isinstance(translations, list):
        joined = "||".join(translations)
    else:
        joined = str(translations)
    return (pick["word"], joined)

STORAGE = os.getenv("STORAGE", "db").lower()
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

def is_file_mode() -> bool:
    return STORAGE == "file"

def _vocab_path(uid: int) -> Path:
    return DATA_DIR / f"vocab_{uid}.json"

def _load_vocab(uid: int) -> list[dict]:
    p = _vocab_path(uid)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return []

def _save_vocab(uid: int, items: list[dict]) -> None:
    p = _vocab_path(uid)
    p.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")

def _next_ids(items: list[dict]) -> tuple[int, int]:
    """return (next_id, next_day_no)"""
    if not items:
        return (1, 1)
    max_id = max(int(x.get("id", 0)) for x in items)
    max_day = max(int(x.get("day_no", 0)) for x in items)
    return (max_id + 1, max_day + 1)

COOKIE_NAME = "session"
COOKIE_PATH = "/"
COOKIE_SAMESITE = "lax"
COOKIE_SECURE = False
connect_args = {}
if DB_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DB_URL, connect_args=connect_args)
signer = URLSafeSerializer(SECRET)

app = FastAPI(title="Vocab Time Capsule Web")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    password_hash: str
    created_at: str = Field(default_factory=lambda: datetime.datetime.utcnow().isoformat())

class Vocab(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    day_no: int
    date: str = Field(index=True)
    word: str
    translation: str

class SessionQuiz(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    quiz_id: str = Field(index=True)
    day_no: int
    created_at: str = Field(default_factory=lambda: datetime.datetime.utcnow().isoformat())
    finished: int = Field(default=0)

class Answer(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    quiz_id: str = Field(index=True)
    word_id: int
    correct: int
    user_answer: str

class SessionScore(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    day_no: int
    ts: str = Field(default_factory=lambda: datetime.datetime.utcnow().isoformat())
    total: int
    correct: int
    accuracy: float

def init_db():
    SQLModel.metadata.create_all(engine)

@app.on_event("startup")
def startup():
    init_db()

def get_db():
    with Session(engine) as s:
        yield s

def current_user(req: Request) -> int:
    cookie = req.cookies.get(COOKIE_NAME)
    if not cookie:
        raise HTTPException(401, "not logged in")
    try:
        data = signer.loads(cookie)
    except BadSignature:
        raise HTTPException(401, "bad session")
    return int(data.get("uid"))

@app.post("/auth/signup")
def signup(email: str = Form(...), password: str = Form(...), resp: Response = None, db: Session = Depends(get_db)):
    if db.exec(select(User).where(User.email == email)).first():
        raise HTTPException(400, "email exists")
    pw = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    u = User(email=email, password_hash=pw)
    db.add(u); db.commit(); db.refresh(u)
    token = signer.dumps({"uid": u.id})
    resp.set_cookie(
        COOKIE_NAME, token,
        httponly=True, samesite=COOKIE_SAMESITE, secure=COOKIE_SECURE, path=COOKIE_PATH
    )
    return {"ok": True, "id": u.id, "email": u.email}

@app.post("/auth/login")
def login(email: str = Form(...), password: str = Form(...), resp: Response = None, db: Session = Depends(get_db)):
    u = db.exec(select(User).where(User.email == email)).first()
    if not u or not bcrypt.checkpw(password.encode(), u.password_hash.encode()):
        raise HTTPException(401, "invalid credentials")
    token = signer.dumps({"uid": u.id})
    resp.set_cookie(
        COOKIE_NAME, token,
        httponly=True, samesite=COOKIE_SAMESITE, secure=COOKIE_SECURE, path=COOKIE_PATH
    )
    return {"ok": True, "id": u.id, "email": u.email}

@app.post("/auth/logout")
def logout(resp: Response):
    resp.delete_cookie(COOKIE_NAME, path=COOKIE_PATH)
    return {"ok": True}

@app.post("/signup")
def signup_json(payload: dict, resp: Response, db: Session = Depends(get_db)):
    email = (payload or {}).get("email")
    password = (payload or {}).get("password")
    if not email or not password:
        raise HTTPException(400, "email and password required")
    if db.exec(select(User).where(User.email == email)).first():
        raise HTTPException(400, "email exists")
    pw = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    u = User(email=email, password_hash=pw)
    db.add(u); db.commit(); db.refresh(u)
    token = signer.dumps({"uid": u.id})
    resp.set_cookie(
        COOKIE_NAME, token,
        httponly=True, samesite=COOKIE_SAMESITE, secure=COOKIE_SECURE, path=COOKIE_PATH
    )
    return {"ok": True, "id": u.id, "email": u.email}

@app.post("/signin")
def signin_json(payload: dict, resp: Response, db: Session = Depends(get_db)):
    email = (payload or {}).get("email")
    password = (payload or {}).get("password")
    if not email or not password:
        raise HTTPException(400, "email and password required")
    u = db.exec(select(User).where(User.email == email)).first()
    if not u or not bcrypt.checkpw(password.encode(), u.password_hash.encode()):
        raise HTTPException(401, "invalid credentials")
    token = signer.dumps({"uid": u.id})
    resp.set_cookie(
        COOKIE_NAME, token,
        httponly=True, samesite=COOKIE_SAMESITE, secure=COOKIE_SECURE, path=COOKIE_PATH
    )
    return {"ok": True, "id": u.id, "email": u.email}

@app.post("/logout")
def logout_json(resp: Response):
    resp.delete_cookie(COOKIE_NAME, path=COOKIE_PATH)
    return {"ok": True}

@app.get("/me")
def me(uid: int = Depends(current_user), db: Session = Depends(get_db)):
    u = db.get(User, uid)
    return {"id": u.id, "email": u.email}

@app.get("/auth/google/login")
def google_login(request: Request):
    if not (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI):
        raise HTTPException(503, "google oauth not configured")

    state = secrets.token_urlsafe(16)
    signed_state = oauth_signer.dumps({"state": state})

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "include_granted_scopes": "true",
        "state": state,
        "prompt": "consent",
    }
    auth_url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"

    resp = RedirectResponse(url=auth_url, status_code=302)
    resp.set_cookie(
        "oauth_state", signed_state,
        httponly=True, samesite=COOKIE_SAMESITE,
        secure=COOKIE_SECURE, path=COOKIE_PATH, max_age=600,
    )
    return resp

@app.get("/auth/google/callback")
def google_callback(code: str = "", state: str = "", request: Request = None, db: Session = Depends(get_db)):
    signed = request.cookies.get("oauth_state")
    if not signed:
        raise HTTPException(400, "missing oauth state")
    try:
        data = oauth_signer.loads(signed)
    except BadSignature:
        raise HTTPException(400, "bad oauth state")
    if data.get("state") != state:
        raise HTTPException(400, "invalid oauth state")

    if not code:
        raise HTTPException(400, "missing code")
    if not (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI):
        raise HTTPException(503, "google oauth not configured")

    try:
        with httpx.Client(timeout=10.0, headers={"User-Agent":"vocab-time-capsule"}) as c:
            token_res = c.post(GOOGLE_TOKEN_URL, data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            })
            token_res.raise_for_status()
            tokens = token_res.json()
            access_token = tokens.get("access_token")
            if not access_token:
                raise HTTPException(400, "no access token")

            ui_res = c.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
            ui_res.raise_for_status()
            profile = ui_res.json()
    except httpx.HTTPError as e:
        raise HTTPException(400, f"oauth exchange failed: {e}")

    email = (profile or {}).get("email")
    if not email:
        raise HTTPException(400, "no email from google")

    u = db.exec(select(User).where(User.email == email)).first()
    if not u:
        rnd = secrets.token_urlsafe(18)
        pw = bcrypt.hashpw(rnd.encode(), bcrypt.gensalt()).decode()
        u = User(email=email, password_hash=pw)
        db.add(u); db.commit(); db.refresh(u)

    token = signer.dumps({"uid": u.id})
    resp = RedirectResponse(url="/")
    resp.set_cookie(COOKIE_NAME, token, httponly=True, samesite=COOKIE_SAMESITE, secure=COOKIE_SECURE, path=COOKIE_PATH)
    resp.delete_cookie("oauth_state", path=COOKIE_PATH)
    return resp

@app.post("/vocab/today/auto")
def vocab_today_auto(uid: int = Depends(current_user), db: Session = Depends(get_db)):
    today = date.today().isoformat()

    if is_file_mode():
        items = _load_vocab(uid)
        for it in items:
            if it.get("date") == today:
                return {"id": it["id"], "date": it["date"], "day_no": it["day_no"],
                        "word": it["word"], "translation": it["translation"], "existing": True}
        used = set((w.get("word","") or "").lower() for w in items)
        
        pair = get_random_word_and_meaning(used)
        if not pair:
            raise HTTPException(503, "no_word_available")
        word, translation = pair
        
        next_id, next_day = _next_ids(items)
        new_item = {"id": next_id, "user_id": uid, "day_no": next_day, "date": today,
                    "word": word, "translation": translation}
        items.append(new_item)
        _save_vocab(uid, items)
        return {"id": new_item["id"], "date": new_item["date"], "day_no": new_item["day_no"],
                "word": new_item["word"], "translation": new_item["translation"], "existing": False}

    existing = db.exec(select(Vocab).where(Vocab.user_id==uid, Vocab.date==today)).first()
    if existing:
        return {
            "id": existing.id, "date": existing.date, "day_no": existing.day_no,
            "word": existing.word, "translation": existing.translation, "existing": True
        }
    used = set(w.word.lower() for w in db.exec(select(Vocab).where(Vocab.user_id==uid)).all())
    
    pair = get_random_word_and_meaning(used)
    if not pair:
        raise HTTPException(503, "no_word_available")
    word, translation = pair

    last = db.exec(select(Vocab).where(Vocab.user_id==uid).order_by(Vocab.day_no.desc())).first()
    next_day = (last.day_no + 1) if last else 1
    v = Vocab(user_id=uid, day_no=next_day, date=today, word=word, translation=translation)
    db.add(v); db.commit(); db.refresh(v)
    return {"id": v.id, "date": v.date, "day_no": v.day_no,
            "word": v.word, "translation": v.translation, "existing": False}

@app.get("/vocab/list")
def vocab_list(uid: int = Depends(current_user), db: Session = Depends(get_db)):
    if is_file_mode():
        return {"items": []}
    rows = db.exec(select(Vocab).where(Vocab.user_id==uid).order_by(Vocab.day_no)).all()
    items = []
    for r in rows:
        tr = r.translation or ""
        if isinstance(tr, str) and "||" in tr:
            t = [s.strip() for s in tr.split("||") if s.strip()]
        else:
            t = tr
        items.append({"id": r.id, "date": r.date, "day_no": r.day_no, "word": r.word, "translation": t})
    return {"items": items}

@app.post("/quiz/start")
def quiz_start(uid: int = Depends(current_user), db: Session = Depends(get_db), request: Request = None):
    qparams = request.query_params if request else {}
    shuffle = qparams.get("shuffle", "1") not in ("0", "false", "False")
    try:
        limit = int(qparams.get("limit", "0"))
    except ValueError:
        limit = 0

    if is_file_mode():
        items = _load_vocab(uid)
        if not items:
            raise HTTPException(400, "no vocab yet")
        items = sorted(items, key=lambda x: int(x.get("day_no", 0)))
        last = items[-1]
        day_no = int(last.get("day_no", 1))
        quiz_id = secrets.token_hex(8)
        q = SessionQuiz(user_id=uid, quiz_id=quiz_id, day_no=day_no, finished=0)
        db.add(q); db.commit()
        pick = list(items)
        if shuffle:
            random.shuffle(pick)
        if limit and 0 < limit < len(pick):
            pick = pick[:limit]
        return {"quiz_id": quiz_id, "day_no": day_no,
                "items":[{"id": it["id"], "day_no": it["day_no"], "word": it["word"]} for it in pick]}
    last = db.exec(select(Vocab).where(Vocab.user_id==uid).order_by(Vocab.day_no.desc())).first()
    if not last:
        raise HTTPException(400, "no vocab yet")
    day_no = last.day_no
    quiz_id = secrets.token_hex(8)
    q = SessionQuiz(user_id=uid, quiz_id=quiz_id, day_no=day_no, finished=0)
    db.add(q); db.commit()
    items = db.exec(select(Vocab).where(Vocab.user_id==uid, Vocab.day_no<=day_no).order_by(Vocab.day_no)).all()
    items = list(items)
    if shuffle:
        random.shuffle(items)
    if limit and 0 < limit < len(items):
        items = items[:limit]
    return {"quiz_id": quiz_id, "day_no": day_no,
            "items":[{"id": it.id, "day_no": it.day_no, "word": it.word} for it in items]}

def _norm(s: str) -> str:
    import re
    s = (s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[\"'`~!@#$%^&*()_+\-=\[\]{};:,.?/\\|<>]", "", s)
    return s

@app.post("/quiz/answer")
def quiz_answer(quiz_id: str = Form(...), word_id: int = Form(...), answer: str = Form(...), uid: int = Depends(current_user), db: Session = Depends(get_db)):
    if is_file_mode():
        return {"correct": False}
    v = db.get(Vocab, word_id)
    if not v or v.user_id != uid:
        raise HTTPException(404, "word not found")
    raw = v.translation or ""
    if isinstance(raw, str) and "||" in raw:
        alternatives = [a for a in (s.strip() for s in raw.split("||")) if a]
    else:
        alternatives = [raw]
    ok = 0
    for alt in alternatives:
        if _norm(answer) == _norm(alt):
            ok = 1
            break
    a = Answer(user_id=uid, quiz_id=quiz_id, word_id=word_id, correct=ok, user_answer=answer)
    db.add(a); db.commit()
    return {"correct": bool(ok), "gold": None if ok else (alternatives if len(alternatives) > 1 else alternatives[0])}

@app.post("/quiz/finish")
def quiz_finish(quiz_id: str = Form(...), uid: int = Depends(current_user), db: Session = Depends(get_db)):
    q = db.exec(select(SessionQuiz).where(SessionQuiz.user_id==uid, SessionQuiz.quiz_id==quiz_id)).first()
    if not q: raise HTTPException(404, "quiz not found")
    if q.finished: return {"ok": True, "message":"already finished"}
    ans = db.exec(select(Answer).where(Answer.user_id==uid, Answer.quiz_id==quiz_id)).all()
    total = len(ans); correct = sum(1 for a in ans if a.correct)
    acc = round(correct/total*100, 2) if total else 0.0
    sc = SessionScore(user_id=uid, day_no=q.day_no, total=total, correct=correct, accuracy=acc)
    q.finished = 1
    db.add(sc); db.add(q); db.commit()
    return {"ok": True, "total": total, "correct": correct, "accuracy": acc}

@app.get("/stats")
def stats(uid: int = Depends(current_user), db: Session = Depends(get_db)):
    if is_file_mode():
        items = _load_vocab(uid)
        max_day = max((int(x.get("day_no", 0)) for x in items), default=0)
    else:
        last_vocab = db.exec(select(Vocab).where(Vocab.user_id==uid).order_by(Vocab.day_no.desc())).first()
        max_day = last_vocab.day_no if last_vocab else 0
    streak = 0
    for dno in range(max_day, 0, -1):
        got = db.exec(select(SessionScore).where(SessionScore.user_id==uid, SessionScore.day_no==dno)).first()
        if got: streak += 1
        else: break
    last = db.exec(select(SessionScore).where(SessionScore.user_id==uid).order_by(SessionScore.day_no.desc())).first()
    return {
        "total_words": max_day,
        "streak": streak,
        "last": {"day_no": last.day_no, "accuracy": last.accuracy} if last else None
    }

@app.get("/export", response_class=PlainTextResponse)
def export(uid: int = Depends(current_user), db: Session = Depends(get_db)):
    if is_file_mode():
        rows = sorted(_load_vocab(uid), key=lambda x: int(x.get("day_no", 0)))
        scores = db.exec(select(SessionScore).where(SessionScore.user_id==uid).order_by(SessionScore.day_no)).all()
        score_map = {s.day_no: s for s in scores}
        lines = ["# Vocab Time Capsule — Export\n",
                "| Day | Date | Word | Translation | Accuracy |",
                "|---:|:---:|---|---|---:|"]
        for r in rows:
            dno = int(r.get("day_no", 0))
            acc = f"{score_map[dno].accuracy}%" if dno in score_map else "-"
            lines.append(f"| {dno} | {r.get('date','')} | {r.get('word','')} | {r.get('translation','')} | {acc} |")
        return "\n".join(lines)
    rows = db.exec(select(Vocab).where(Vocab.user_id==uid).order_by(Vocab.day_no)).all()
    scores = db.exec(select(SessionScore).where(SessionScore.user_id==uid).order_by(SessionScore.day_no)).all()
    score_map = {s.day_no: s for s in scores}
    lines = ["# Vocab Time Capsule — Export\n",
            "| Day | Date | Word | Translation | Accuracy |",
            "|---:|:---:|---|---|---:|"]
    for r in rows:
        acc = f"{score_map[r.day_no].accuracy}%" if r.day_no in score_map else "-"
        lines.append(f"| {r.day_no} | {r.date} | {r.word} | {r.translation} | {acc} |")
    return "\n".join(lines)

@app.get("/vocab/random")
def vocab_random(limit: int = 10, uid: int = Depends(current_user), db: Session = Depends(get_db)):
    if is_file_mode():
        return {"items": []}
    rows = db.exec(select(Vocab).where(Vocab.user_id==uid).order_by(Vocab.day_no.desc()).limit(limit)).all()
    items = []
    for r in rows:
        tr = r.translation or ""
        if isinstance(tr, str) and "||" in tr:
            t = [s.strip() for s in tr.split("||") if s.strip()]
        else:
            t = tr
        items.append({"id": r.id, "date": r.date, "day_no": r.day_no, "word": r.word, "translation": t})
    return {"items": items}

@app.post("/vocab/reset")
def vocab_reset(uid: int = Depends(current_user), db: Session = Depends(get_db)):
    if is_file_mode():
        p = _vocab_path(uid)
        if p.exists():
            p.unlink()
    else:
        db.exec(delete(Vocab).where(Vocab.user_id == uid))
    db.exec(delete(Answer).where(Answer.user_id == uid))
    db.exec(delete(SessionQuiz).where(SessionQuiz.user_id == uid))
    db.exec(delete(SessionScore).where(SessionScore.user_id == uid))
    db.commit()
    return {"ok": True, "message": "reset done"}

static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/static/index.html")