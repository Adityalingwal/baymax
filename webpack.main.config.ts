import type { Configuration } from "webpack";
import CopyWebpackPlugin from "copy-webpack-plugin";

import { rules } from "./webpack.rules";
import { plugins } from "./webpack.plugins";

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: "./src/index.ts",
  // Put your normal webpack config below here
  module: {
    rules,
  },
  plugins: [
    ...plugins,
    // Native modules cannot be bundled: copy them next to the main bundle so
    // the external require below resolves at runtime.
    new CopyWebpackPlugin({
      patterns: [
        {
          from: "node_modules/uiohook-napi",
          to: "node_modules/uiohook-napi",
        },
        {
          from: "node_modules/node-gyp-build",
          to: "node_modules/node-gyp-build",
        },
      ],
    }),
  ],
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css", ".json"],
  },
  externals: {
    // Mark uiohook-napi as external so webpack doesn't bundle the native module
    "uiohook-napi": "commonjs uiohook-napi",
  },
};
