import type { Configuration, ModuleOptions } from "webpack";

import { plugins } from "./webpack.plugins";

// The renderer gets its own rule list on purpose: the shared `webpack.rules.ts`
// carries the native-module loaders (node-loader + asset relocator) that only
// the main process needs. Relocator >= 1.8 injects a `__dirname` runtime into
// any bundle it touches, and `__dirname` does not exist in a sandboxed renderer.
const rendererRules: Required<ModuleOptions>["rules"] = [
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack)/,
    use: {
      loader: "ts-loader",
      options: {
        transpileOnly: true,
      },
    },
  },
  {
    test: /\.css$/,
    use: [
      { loader: "style-loader" },
      { loader: "css-loader" },
      { loader: "postcss-loader" },
    ],
  },
  {
    test: /\.(png|jpe?g|gif|svg|woff2?)$/i,
    type: "asset/resource",
  },
];

export const rendererConfig: Configuration = {
  // Use source-map instead of eval-based devtool — eval is blocked by CSP
  devtool: "source-map",
  module: {
    rules: rendererRules,
  },
  plugins,
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css"],
  },
};
