// Used by tsdown (css.transformer: 'postcss') for both the extension webview and the browser preview.
import tailwindcss from '@tailwindcss/postcss';

export default { plugins: [tailwindcss()] };
