// فحص كود الواجهة: قواعد JavaScript وTypeScript الموصى بها + قواعد React Hooks
// (التبعيات الناقصة في useEffect والاستدعاءات داخل الشروط).
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "scripts/**", ".claude/**", "**/target/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // قواعد React Compiler الصارمة: تحذير الآن، وتُعالَج في دفعة إعادة الهيكلة.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
);
