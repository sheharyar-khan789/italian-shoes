// Marks the page as JS-enabled before first paint (blocking on purpose; tiny). Kept in a file, not
// inline, so the Content Security Policy can forbid all inline scripts.
document.documentElement.classList.add("js");
