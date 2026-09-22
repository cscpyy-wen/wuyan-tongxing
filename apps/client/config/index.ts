import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import devConfig from './dev'
import prodConfig from './prod'

declare const __dirname: string
const pathSeparator = __dirname.includes('\\') ? '\\' : '/'
const sharedPackagesPath = __dirname.replace(
  /[\\/]apps[\\/]client[\\/]config$/,
  `${pathSeparator}packages`,
)

export default defineConfig<'webpack5'>(async (merge, { mode }) => {
  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'wuyan-tongxing',
    date: '2026-08-23',
    designWidth: 375,
    deviceRatio: {
      375: 2,
      640: 1.17,
      750: 1,
    },
    sourceRoot: 'src',
    outputRoot: `dist/${process.env.TARO_ENV ?? 'h5'}`,
    framework: 'react',
    compiler: 'webpack5',
    cache: { enable: true },
    mini: {
      compile: {
        include: [sharedPackagesPath],
      },
      commonChunks: (chunks) => [...chunks, 'content'],
      webpackChain(chain) {
        // Keep the offline content catalog out of WeApp's shared UI chunk.
        chain.merge({
          optimization: {
            splitChunks: {
              cacheGroups: {
                content: {
                  name: 'content',
                  test: /[\\/]packages[\\/]content[\\/]/,
                  chunks: 'all',
                  priority: 20,
                  enforce: true,
                },
              },
            },
          },
        })
      },
      postcss: {
        pxtransform: { enable: true, config: {} },
        cssModules: { enable: false },
      },
    },
    h5: {
      compile: {
        include: [sharedPackagesPath],
      },
      publicPath: '/',
      staticDirectory: 'static',
      router: { mode: 'hash' },
      postcss: {
        autoprefixer: { enable: true, config: {} },
        cssModules: { enable: false },
      },
    },
  }

  return merge({}, baseConfig, mode === 'development' ? devConfig : prodConfig)
})
