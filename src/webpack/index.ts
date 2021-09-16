import fs from 'fs'
import { fileURLToPath } from 'url'
import path from 'upath'
import VirtualModulesPlugin from 'webpack-virtual-modules'
import type { Resolver, ResolveRequest } from 'enhanced-resolve'
import type { UnpluginContextMeta, UnpluginInstance, UnpluginFactory, WebpackCompiler, ResolvedUnpluginOptions } from '../types'

const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
const TRANSFORM_LOADER = path.resolve(_dirname, 'webpack/loaders/transform.js')
const LOAD_LOADER = path.resolve(_dirname, 'webpack/loaders/load.js')

export function getWebpackPlugin<UserOptions = {}> (
  factory: UnpluginFactory<UserOptions>
): UnpluginInstance<UserOptions>['webpack'] {
  return (userOptions?: UserOptions) => {
    return {
      apply (compiler: WebpackCompiler) {
        const meta: UnpluginContextMeta = {
          framework: 'webpack',
          webpack: {
            compiler
          }
        }

        const rawPlugin = factory(userOptions, meta)
        const plugin = Object.assign(
          rawPlugin,
          {
            __unpluginMeta: meta,
            __virtualModulePrefix: path.join(process.cwd(), 'virtual:')
          }
        ) as ResolvedUnpluginOptions

        // inject context object to share with loaders
        const injected = compiler.$unpluginContext || {}
        compiler.$unpluginContext = injected
        injected[plugin.name] = plugin

        compiler.hooks.thisCompilation.tap(plugin.name, (compilation) => {
          compilation.hooks.childCompiler.tap(plugin.name, (childCompiler) => {
            childCompiler.$unpluginContext = injected
          })
        })

        // transform hook
        if (plugin.transform) {
          compiler.options.module.rules.push({
            include (id: string) {
              if (id == null) {
                return false
              }
              if (plugin.transformInclude) {
                return plugin.transformInclude(id)
              } else {
                return true
              }
            },
            enforce: plugin.enforce,
            use: [{
              loader: TRANSFORM_LOADER,
              options: {
                unpluginName: plugin.name
              }
            }]
          })
        }

        // resolveId hook
        if (plugin.resolveId) {
          let vfs = compiler.options.plugins.find(i => i instanceof VirtualModulesPlugin) as VirtualModulesPlugin
          if (!vfs) {
            vfs = new VirtualModulesPlugin()
            compiler.options.plugins.push(vfs)
          }
          plugin.__vfsModules = new Set()
          plugin.__vfs = vfs

          const resolver = {
            apply (resolver: Resolver) {
              const target = resolver.ensureHook('resolve')
              const tap = () => async (request: ResolveRequest, resolveContext: any, callback: any) => {
                // filter out invalid requests
                if (!request.request || request.request.startsWith(plugin.__virtualModulePrefix)) {
                  return callback()
                }

                // call hook
                const result = await plugin.resolveId!(request.request)
                if (result == null) {
                  return callback()
                }
                let resolved = typeof result === 'string' ? result : result.id

                // TODO: support external
                // const isExternal = typeof result === 'string' ? false : result.external === true

                // if the resolved module is not exists,
                // we treat it as a virtual module
                if (!fs.existsSync(resolved)) {
                  resolved = plugin.__virtualModulePrefix + request.request
                  plugin.__vfs!.writeModule(resolved, '')
                  plugin.__vfsModules!.add(resolved)
                }

                // construt the new request
                const newRequest = {
                  ...request,
                  request: resolved
                }

                // redirect the resolver
                resolver.doResolve(target, newRequest, null, resolveContext, callback)
              }

              resolver
                .getHook('resolve')
                .tapAsync('unplugin', tap())
            }
          }

          compiler.options.resolve.plugins = compiler.options.resolve.plugins || []
          compiler.options.resolve.plugins.push(resolver)
        }

        // load hook
        if (plugin.load && plugin.__vfsModules) {
          compiler.options.module.rules.push({
            include (id) {
              return id != null && plugin.__vfsModules!.has(id)
            },
            enforce: plugin.enforce,
            use: [{
              loader: LOAD_LOADER,
              options: {
                unpluginName: plugin.name
              }
            }]
          })
        }

        if (plugin.webpack) {
          plugin.webpack(compiler)
        }

        plugin.buildStart?.()
      }
    }
  }
}