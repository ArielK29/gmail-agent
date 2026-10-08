# סוכן Gmail (תרגיל)

סוכן שקורא את המיילים **החדשים** שלך ב-Gmail (קריאה בלבד), מסווג כל מייל לקטגוריה ומסכם אותו במשפט אחד בעברית. מציג את הכול בדף. **תוכן המייל לא נשמר**, רק שולח, נושא, קטגוריה וסיכום.

## החלטות ארכיטקטורה
| נושא | החלטה |
|---|---|
| חיבור ל-Gmail | OAuth נפרד מההתחברות, הרשאה `gmail.readonly` בלבד, `access_type=offline` (refresh token) |
| איפה נשמר ה-token | טבלה בשרת (`gmail_connections`). הדפדפן לא יכול לקרוא אותו, רק פונקציות השרת |
| זיהוי מיילים חדשים | `history.list` של Gmail מאז המיקום ששמרנו. בדיקה תקופתית (כל 10 דקות, pg_cron) + כפתור "בדוק עכשיו" |
| מה נשמר | שולח, נושא, קטגוריה, סיכום (לא גוף המייל) |
| מודל | Claude Haiku, בלי כלים ובלי יכולת לפעול. המיילים מוגדרים כמידע לא אמין (הגנה מ-prompt injection) |
| משתמשים | רק אתה, מצב בדיקה של Google (בלי אימות Google) |
| פעולה על מייל חשוב | רק מציג בדף |
| ניתוק | `gmail-disconnect` מבטל את ההרשאה אצל Google ומוחק את החיבור והסיכומים |

## מבנה
```
supabase/migrations/001_gmail_agent.sql   טבלאות ו-RLS
supabase/migrations/002_schedule.sql      בדיקה כל 10 דקות
supabase/functions/gmail-connect          מתחיל את החיבור (מחזיר כתובת של Google)
supabase/functions/gmail-callback         Google חוזר לכאן, שומר את ה-token
supabase/functions/gmail-sync             הסוכן: מוצא מיילים חדשים, מסווג ומסכם
supabase/functions/gmail-disconnect       ניתוק
public/index.html                         הדף (התחברות, חיבור, "בדוק עכשיו", רשימה)
```

## מה אתה צריך לעשות (אני לא מקליד סודות ולא פותח חשבונות)
1. **Google Cloud** (https://console.cloud.google.com): צור פרויקט חדש → APIs & Services → Library → הפעל **Gmail API**.
2. **מסך הסכמה (זה "המיתוג")**: APIs & Services → OAuth consent screen → External → שם האפליקציה (למשל "סוכן Gmail"), מייל תמיכה, → Scopes: הוסף `.../auth/gmail.readonly` → **Test users**: הוסף את כתובת ה-Gmail שלך. השאר במצב **Testing**.
3. **אישורים**: Credentials → Create credentials → OAuth client ID → Web application → Authorized redirect URI: `https://<PROJECT_REF>.supabase.co/functions/v1/gmail-callback` (אני אתן לך את הכתובת המדויקת). קבל **Client ID** ו-**Client secret**.
4. **Anthropic**: מפתח API מ-https://console.anthropic.com.
5. **ב-Supabase** → Edge Functions → Secrets: הדבק בעצמך `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, ו-`APP_URL` (כתובת הדף).

## הערות
- ב-Testing, ה-refresh token של Google פג אחרי 7 ימים: צריך ללחוץ "חבר את Gmail" שוב. זו מגבלה של Google לתרגיל.
- הריצה מוגבלת ל-20 מיילים בכל פעם ולכל היותר 25 חיבורים בריצה מתוזמנת.
