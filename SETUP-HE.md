# הגדרת סוכן Gmail: מה לעשות, שלב אחר שלב

כל מה שהקוד צריך כבר פרוס ב-Supabase (פרויקט `ArielK29's Project`). נשארו רק הצעדים בחשבונות שלך. את הסודות מדביקים אתה בעצמך, אני לא מקליד אותם בשום מקום.

## ערכים שתצטרך (קבועים)
| מה | ערך |
|---|---|
| כתובת ה-redirect (להדבקה ב-Google) | `https://ppkbuyiatkxpfeqmvwzb.supabase.co/functions/v1/gmail-callback` |
| כתובת הדף (`APP_URL`) | `http://localhost:5174` |
| הרשאה שמבקשים | `https://www.googleapis.com/auth/gmail.readonly` |

## שלב 1 · Google Cloud
1. היכנס ל-https://console.cloud.google.com עם חשבון ה-Gmail שלך.
2. למעלה: בחירת פרויקט ← **פרויקט חדש** ← שם: `gmail-agent` ← יצירה.
3. תפריט ← **APIs & Services** ← **Library** ← חפש **Gmail API** ← **Enable**.

## שלב 2 · מסך הסכמה ומיתוג (OAuth consent screen)
1. **APIs & Services** ← **OAuth consent screen** (או **Google Auth Platform**) ← **Get started**.
2. App name: `סוכן Gmail` (זה המיתוג שהמשתמש רואה). User support email: המייל שלך.
3. Audience: **External**. Contact email: המייל שלך. אשר את התנאים ← **Create**.
4. **Data Access** ← **Add or remove scopes** ← הוסף `gmail.readonly` (וגם `openid` ו-`email`) ← Save.
5. **Audience** ← **Publish app** ← אשר. (מצב Production ללא אימות, כדי שהחיבור לא יפוג אחרי 7 ימים.)

## שלב 3 · אישורי OAuth
1. **Clients** (או **Credentials**) ← **Create client** ← Application type: **Web application**.
2. Name: `gmail-agent`.
3. **Authorized redirect URIs** ← הדבק בדיוק: `https://ppkbuyiatkxpfeqmvwzb.supabase.co/functions/v1/gmail-callback`
4. **Create**. שמור את **Client ID** ואת **Client secret**.

## שלב 4 · מפתח Gemini (חינמי)
1. https://aistudio.google.com/apikey ← **Create API key** ← בחר את הפרויקט `gmail-agent` ← העתק את המפתח.

## שלב 5 · סודות ב-Supabase (אתה מדביק)
Supabase ← הפרויקט `ArielK29's Project` ← **Edge Functions** ← **Secrets** ← הוסף:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GEMINI_API_KEY`
- `APP_URL` = `https://arielk29.github.io/gmail-agent/`

## שלב 6 · משתמש בפרויקט
הדף מתחבר עם אימייל וסיסמה בפרויקט הזה. אני לא יוצר חשבונות, לכן כשהדף יעלה תלחץ שם "יצירת חשבון".

## שלב 7 · הפעלה
תגיד לי "סיימתי". אפעיל את הדף המקומי, ואתה: התחברות ← **חבר את Gmail** ← "מתקדם" ← "המשך" (אזהרת אפליקציה לא מאומתת, צפויה) ← אישור ← **בדוק מיילים חדשים עכשיו**.

## אם משהו נתקע
- `redirect_uri_mismatch`: הכתובת בשלב 3 לא זהה לחלוטין לכתובת בטבלה.
- אחרי החיבור אין סיכומים: בדוק שהגדרת `GEMINI_API_KEY` ושיש מיילים בתיבה מהיומיים האחרונים.
