/// <reference types="vite/client" />

/** `import('...?url')` 的返回形状：vite 把它编译成一个资产地址字符串。 */
declare module '*?url' {
  const url: string
  export default url
}
