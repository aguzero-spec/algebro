// Loads a bundled library (from vendor/) the first time it's needed, so the page opens quickly.
// Libraries are copied into this site and pinned to exact versions (see vendor/README.md);
// the security policy blocks loading code from anywhere else.

const loaded = {};

export function loadScript(path, globalName) {
  loaded[path] ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = path;
    script.onload = () => (window[globalName] ? resolve(window[globalName])
      : reject(new Error(`The ${globalName} library didn't load correctly. Reload the page and try again.`)));
    script.onerror = () => {
      delete loaded[path];
      reject(new Error("Part of the app couldn't be loaded. Check your internet connection and try again."));
    };
    document.head.appendChild(script);
  });
  return loaded[path];
}
