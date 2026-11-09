/** "5 Nov 2026, 3:42 pm" in Pakistan time. Accepts a Firestore Timestamp, Date or ISO string. */
export function formatWhen(date) {
  if (!date) return "—";
  const d = typeof date.toDate === "function" ? date.toDate() : new Date(date);
  return d.toLocaleString("en-PK", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Karachi" });
}
