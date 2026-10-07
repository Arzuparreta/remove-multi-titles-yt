// Like YouTube Anti Translate: runs its page code from a <script> tag
// pointing at the extension package.
const script = document.createElement("script");
script.src = (globalThis.browser ?? chrome).runtime.getURL("page.js");
(document.head || document.documentElement).appendChild(script);
