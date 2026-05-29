declare module "abcjs" {
  export function renderAbc(target: string | HTMLElement, abc: string, options?: any): any;
  const def: { renderAbc: typeof renderAbc };
  export default def;
}
