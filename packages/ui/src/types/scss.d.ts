// Ambient declaration so `.module.scss` imports typecheck as a class map.
// The consuming bundler (Vite, with `sass` installed) turns the import into the
// runtime object of locally-scoped class names.
declare module "*.module.scss" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module "*.scss";
