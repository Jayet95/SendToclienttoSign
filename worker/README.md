# Worker — backend לחתימות ושליחת וואטסאפ

Cloudflare Worker שמספק את ה-backend של המערכת: יצירת קישור חתימה, שמירת החתימה,
ושליחת הקישור בוואטסאפ.

## Endpoints

| מתודה | נתיב | תיאור |
|-------|------|-------|
| `POST` | `/api/sessions` | יוצר סשן חתימה. גוף: `{patient:{firstName,lastName,id,file,address,phone}, referral, treatment, catalog, date}`. מחזיר `{id, signUrl, waLink}`. |
| `GET` | `/api/sessions/:id` | מחזיר את הסשן (למטפלת — לבדוק אם נחתם ולשלוף את החתימה). |
| `POST` | `/api/sessions/:id/sign` | שומר את החתימה. גוף: `{signature:"data:image/png;base64,..."}`. **חתימה חוזרת חסומה** (409 `already_signed`). |
| `POST` | `/api/whatsapp` | שולח את הקישור. גוף: `{phone, message}`. עם Business API — שולח באמת; אחרת מחזיר קישור `wa.me`. |
| `GET` | `/s/:id` | דף החתימה שהמטופל פותח (HTML + חתימה באצבע). |

עקרון ה-**resend**: כל עוד הסשן לא נחתם אפשר לשלוח שוב את הקישור ולחתום; רק אחרי חתימה הוא ננעל (409).

## הקמה

```bash
cd worker
npm i -g wrangler        # או npx wrangler

# 1) KV לשמירת הסשנים
npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create SESSIONS --preview
# הדביקו את ה-id ו-preview_id ב-wrangler.toml

# 2) הרצה מקומית
npx wrangler dev

# 3) פריסה
npx wrangler deploy
```

### WhatsApp Business API (רשות)

```bash
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_ID
```

בלי הסודות האלה — ה-Worker מחזיר קישור `wa.me` (חצי-אוטומטי: המטפלת לוחצת שלח).

## חיבור לפרונטאנד

ה-`index.html` הסטטי (Cloudflare Pages) יקרא ל-Worker:
`fetch('https://<worker>.workers.dev/api/sessions', {...})` ואז ישלח את ה-`signUrl` בוואטסאפ.
כרגע הפרונט הוא דמו עצמאי; חיבור מלא ל-Worker הוא הצעד הבא.

## אחסון

כרגע **KV** (מתאים לסשנים קצרי-מועד). לרשומות מטופלים/היסטוריה/דוחות לחיוב —
עדיף **D1** (בסיס SQL של Cloudflare). ראו את הדיון ב-README הראשי.
