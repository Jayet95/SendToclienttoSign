/**
 * SendToClientToSign — Cloudflare Worker (backend)
 *
 * Turns the static demo into a real service:
 *   - creates a signing session and a unique link
 *   - serves the patient signing page for that link
 *   - stores the signature (once — a session can't be signed twice)
 *   - lets the clinic poll the session / fetch the signed form
 *   - sends the link over WhatsApp (Business API when configured, else a wa.me link)
 *
 * Storage: KV namespace `SESSIONS` (one JSON doc per session, 30-day TTL).
 */

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));

    try {
      // POST /api/sessions  -> create a signing session
      if (pathname === "/api/sessions" && method === "POST") {
        return cors(env, await createSession(request, env, url));
      }

      // GET /api/sessions/:id  -> read a session (for the clinic)
      let m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
      if (m && method === "GET") {
        return cors(env, await getSession(env, m[1]));
      }

      // POST /api/sessions/:id/sign  -> store the signature (once)
      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/sign$/);
      if (m && method === "POST") {
        return cors(env, await signSession(request, env, m[1]));
      }

      // POST /api/whatsapp  -> send the link over WhatsApp
      if (pathname === "/api/whatsapp" && method === "POST") {
        return cors(env, await sendWhatsApp(request, env));
      }

      // GET /s/:id  -> the patient-facing signing page
      m = pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
      if (m && method === "GET") {
        return signingPage(env, m[1]);
      }

      // GET /  -> tiny health/info page
      if (pathname === "/" && method === "GET") {
        return json({ service: "SendToClientToSign", ok: true });
      }

      return cors(env, json({ error: "not_found" }, 404));
    } catch (err) {
      return cors(env, json({ error: "server_error", detail: String(err) }, 500));
    }
  },
};

/* ------------------------- handlers ------------------------- */

async function createSession(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const patient = body.patient || {};
  if (!patient.id || !(patient.firstName || patient.lastName)) {
    return json({ error: "missing_patient", message: "נדרשים שם המטופל ותעודת זהות." }, 400);
  }
  const id = newId();
  const session = {
    id,
    status: "pending",
    createdAt: new Date().toISOString(),
    signedAt: null,
    signature: null,
    patient: {
      firstName: patient.firstName || "",
      lastName: patient.lastName || "",
      id: patient.id,
      file: patient.file || "",
      address: patient.address || "",
      phone: patient.phone || "",
    },
    treatment: {
      referral: body.referral || "",
      name: body.treatment || "סל טיפול פיזיותרפיה",
      catalog: body.catalog || "",
      date: body.date || todayISO(),
    },
    clinic: env.CLINIC_NAME || "מכון פיזיותרפיה",
  };
  await env.SESSIONS.put(id, JSON.stringify(session), { expirationTtl: SESSION_TTL });

  const signUrl = `${url.origin}/s/${id}`;
  const waLink = waMeLink(session.patient.phone, waMessage(session, signUrl));
  return json({ id, status: "pending", signUrl, waLink }, 201);
}

async function getSession(env, id) {
  const raw = await env.SESSIONS.get(id);
  if (!raw) return json({ error: "not_found" }, 404);
  const s = JSON.parse(raw);
  return json(s);
}

async function signSession(request, env, id) {
  const raw = await env.SESSIONS.get(id);
  if (!raw) return json({ error: "not_found" }, 404);
  const s = JSON.parse(raw);

  // validation: a session can be signed only once
  if (s.status === "signed") {
    return json({ error: "already_signed", signedAt: s.signedAt }, 409);
  }

  const body = await request.json().catch(() => ({}));
  const sig = body.signature;
  if (!sig || typeof sig !== "string" || !sig.startsWith("data:image")) {
    return json({ error: "invalid_signature" }, 400);
  }
  if (sig.length > 400_000) {
    return json({ error: "signature_too_large" }, 413);
  }

  s.status = "signed";
  s.signedAt = new Date().toISOString();
  s.signature = sig;
  await env.SESSIONS.put(id, JSON.stringify(s), { expirationTtl: SESSION_TTL });
  return json({ ok: true, status: "signed", signedAt: s.signedAt });
}

async function sendWhatsApp(request, env) {
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  const text = body.message || "";
  if (!phone) return json({ error: "invalid_phone" }, 400);

  // If Business API credentials are configured, send for real.
  if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: text },
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    return json({ sent: res.ok, via: "business_api", response: data }, res.ok ? 200 : 502);
  }

  // Fallback: return a click-to-chat link the clinic can open.
  return json({ sent: false, via: "wa_me", waLink: waMeLink(phone, text) });
}

/* ------------------------- signing page ------------------------- */

async function signingPage(env, id) {
  const raw = await env.SESSIONS.get(id);
  if (!raw) {
    return html(`<div class="card"><h1>הקישור לא נמצא</h1><p>ייתכן שפג תוקפו.</p></div>`, 404);
  }
  const s = JSON.parse(raw);
  const p = s.patient, t = s.treatment;
  const already = s.status === "signed";

  const body = `
  <div class="card">
    <div class="gov">מדינת ישראל · משרד הביטחון · אגף השיקום</div>
    <h1>אישור ביצוע טיפול</h1>
    <div class="rows">
      <div><span>מטופל/ת</span><b>${esc(p.firstName)} ${esc(p.lastName)}</b></div>
      <div><span>ת.ז</span><b>${esc(p.id)}</b></div>
      <div><span>מס' הפניה</span><b>${esc(t.referral)}</b></div>
      <div><span>סוג הטיפול</span><b>${esc(t.name)}</b></div>
      <div><span>תאריך הטיפול</span><b class="hl">${esc(t.date)}</b></div>
    </div>
    <p class="declare">אני החתום/ה מטה מאשר/ת כי קיבלתי את הטיפול המפורט לעיל בתאריך זה.</p>

    <div id="signArea" ${already ? "hidden" : ""}>
      <div class="siglabel">חתמו כאן באצבע</div>
      <div class="padwrap"><canvas id="pad"></canvas><div class="padph" id="padph">✍️ חתימה</div></div>
      <div class="actions">
        <button class="btn ghost" id="clr">נקה</button>
        <button class="btn ok" id="ok" disabled>אישור ושליחה</button>
      </div>
    </div>

    <div id="done" ${already ? "" : "hidden"}>
      <div class="ring">✓</div>
      <h2>נחתם בהצלחה</h2>
      <p>תודה. אישור הטיפול נשמר ונשלח למטפלת.</p>
    </div>
  </div>`;

  return html(body);
}

/* ------------------------- helpers ------------------------- */

function newId() {
  // URL-safe short id
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function todayISO() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

// 05XXXXXXXX -> 9725XXXXXXXX ; keeps already-international numbers
function normalizePhone(raw) {
  if (!raw) return "";
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("972")) return d;
  if (d.startsWith("0")) return "972" + d.slice(1);
  if (d.length === 9) return "972" + d; // missing leading 0
  return d;
}

function waMeLink(phone, text) {
  const p = normalizePhone(phone);
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

function waMessage(session, signUrl) {
  const name = session.patient.firstName || "";
  return `שלום ${name}, לחתימה על אישור הטיפול מהיום (${session.treatment.date}): ${signUrl}`;
}

function cors(env, res) {
  const origin = (env && env.ALLOWED_ORIGIN) || "*";
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function esc(str) {
  return String(str || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function html(inner, status = 200) {
  const page = `<!doctype html><html dir="rtl" lang="he"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>חתימה על אישור טיפול</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;background:#eef0f3;color:#1a2233;font-family:-apple-system,"Segoe UI",Arial,sans-serif;
    display:flex;justify-content:center;padding:18px;line-height:1.5}
  @media(prefers-color-scheme:dark){body{background:#0d1117;color:#e8ecf2}}
  .card{background:#fff;border-radius:16px;max-width:440px;width:100%;padding:22px;
    box-shadow:0 10px 40px rgba(20,30,50,.12)}
  @media(prefers-color-scheme:dark){.card{background:#161c26}}
  .gov{text-align:center;font-size:12px;color:#5a6473;border-bottom:1px solid #dde1e7;padding-bottom:9px}
  @media(prefers-color-scheme:dark){.gov{border-color:#2a3340;color:#9aa6b6}}
  h1{font-size:19px;text-align:center;margin:14px 0 16px}
  .rows>div{display:flex;justify-content:space-between;padding:5px 0;font-size:14px}
  .rows span{color:#8b95a4}.rows b{font-weight:600}.hl{color:#0f6e68}
  @media(prefers-color-scheme:dark){.hl{color:#3fb6ad}}
  .declare{font-size:13px;color:#5a6473;background:#f7f8fa;border-radius:9px;padding:11px;margin:14px 0}
  @media(prefers-color-scheme:dark){.declare{background:#1c232f;color:#9aa6b6}}
  .siglabel{font-weight:700;font-size:14px;margin-bottom:8px}
  .padwrap{position:relative;border:2px dashed #cfd5dd;border-radius:12px;overflow:hidden;touch-action:none;background:#fff}
  @media(prefers-color-scheme:dark){.padwrap{border-color:#3a4756}}
  canvas{display:block;width:100%;height:190px}
  .padph{position:absolute;inset:0;display:grid;place-items:center;color:#8b95a4;pointer-events:none;font-size:14px}
  .actions{display:flex;gap:10px;margin-top:12px}
  .btn{flex:1;border:none;border-radius:11px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
  .btn.ghost{flex:0 0 auto;background:#f0f2f5;color:#1a2233;border:1px solid #dde1e7}
  @media(prefers-color-scheme:dark){.btn.ghost{background:#1c232f;color:#e8ecf2;border-color:#2a3340}}
  .btn.ok{background:#1f8a4c;color:#fff}.btn.ok:disabled{background:#cfd5dd;cursor:not-allowed}
  #done{text-align:center;padding:16px 0}
  .ring{width:64px;height:64px;border-radius:50%;background:#e4f4ea;color:#1f8a4c;font-size:32px;
    display:grid;place-items:center;margin:0 auto 12px}
  @media(prefers-color-scheme:dark){.ring{background:#123021;color:#4cc47e}}
  h2{font-size:18px;margin:0 0 6px}
</style></head><body>${inner}
<script>
(function(){
  var id = location.pathname.split('/').pop();
  var cv = document.getElementById('pad'); if(!cv) return;
  var ctx = cv.getContext('2d'), ratio = window.devicePixelRatio||1;
  function fit(){ var r=cv.getBoundingClientRect(); cv.width=r.width*ratio; cv.height=r.height*ratio;
    ctx.scale(ratio,ratio); ctx.strokeStyle='#15233a'; ctx.lineWidth=2.4;
    ctx.lineCap='round'; ctx.lineJoin='round'; }
  fit();
  var drawing=false, drew=false, last=null;
  function pos(e){ var b=cv.getBoundingClientRect(), t=e.touches?e.touches[0]:e;
    return {x:t.clientX-b.left, y:t.clientY-b.top}; }
  function start(e){ e.preventDefault(); drawing=true; last=pos(e); }
  function move(e){ if(!drawing)return; e.preventDefault(); var p=pos(e);
    ctx.beginPath(); ctx.moveTo(last.x,last.y); ctx.lineTo(p.x,p.y); ctx.stroke(); last=p;
    if(!drew){ drew=true; document.getElementById('padph').hidden=true; document.getElementById('ok').disabled=false; } }
  function end(){ drawing=false; }
  cv.addEventListener('mousedown',start); cv.addEventListener('mousemove',move); window.addEventListener('mouseup',end);
  cv.addEventListener('touchstart',start,{passive:false}); cv.addEventListener('touchmove',move,{passive:false}); cv.addEventListener('touchend',end);
  document.getElementById('clr').onclick=function(){ ctx.clearRect(0,0,cv.width,cv.height); drew=false;
    document.getElementById('padph').hidden=false; document.getElementById('ok').disabled=true; };
  document.getElementById('ok').onclick=function(){
    var btn=this; btn.disabled=true; btn.textContent='שולח...';
    fetch('/api/sessions/'+id+'/sign',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({signature:cv.toDataURL('image/png')})})
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
      .then(function(res){
        if(res.ok){ document.getElementById('signArea').hidden=true; document.getElementById('done').hidden=false; }
        else if(res.d && res.d.error==='already_signed'){ alert('הטופס כבר נחתם.'); location.reload(); }
        else { alert('שגיאה בשמירת החתימה. נסו שוב.'); btn.disabled=false; btn.textContent='אישור ושליחה'; }
      })
      .catch(function(){ alert('שגיאת רשת. נסו שוב.'); btn.disabled=false; btn.textContent='אישור ושליחה'; });
  };
})();
</script>
</body></html>`;
  return new Response(page, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
