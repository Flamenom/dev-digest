/* Star re-export: the `export { ContextTab, ContextTab as default } from …`
   form made webpack drop the named export at bundle time ("Attempted import
   error: 'ContextTab' is not exported…"), rendering the tab as `undefined`
   in the browser while tsc/vitest stayed green. Caught by the project-context
   e2e flow. */
export * from "./ContextTab";
export { ContextTab as default } from "./ContextTab";
