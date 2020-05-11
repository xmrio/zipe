import { init as initLexer } from "es-module-lexer";
import { ServerPlugin, ServerPluginContext, rewriteImports } from "vite";
import { ssrBuild } from "./ssrBuild";
import resolve from "resolve-from";
import { buildViteCache, buildViteModuleResolver } from "./vite";
import { buildMemoryCache } from "./next";
import { buildOutputPipeline } from "./next/outputPipeline";
import { moduleRewrite } from "./next/transformers/moduleRewrite";
import { loadPostcssConfig, resolveCompiler } from "vite/dist/utils";
import { buildSFCParser } from "./next/parsers/sfcParser";
import { outputSSR } from "./outputSSR";
import { scriptTransforms, ZipeScriptTransform } from "./next/transformers";
import { scriptTransforms as ViteTransformers } from "./vite/transformers";

export function createZipePrerender(options?: {
  component: string;
}): ServerPlugin {
  options = options ?? { component: "/App.vue" };

  return ({ app, root, watcher, resolver, server }) => {
    app.use(async (ctx, next) => {
      if (ctx.path === "/") {
        await initLexer;
        const html = await ssrBuild(
          resolver.requestToFile(options!.component),
          resolver,
          root,
          watcher
        );
        ctx.body = html;
        return;
      }

      await next();
    });
  };
}

export type ZipeBuilder = (component: string) => Promise<string>;

export type ZipeViteContext = { zipeSSR: ZipeBuilder } & ServerPluginContext;

export function createViteSSR(
  plugin: (ctx: ZipeViteContext) => void
): ServerPlugin {
  return (ctx) => {
    const { root, watcher, resolver } = ctx;
    const cache = buildViteCache(resolver);
    const moduleResolver = buildViteModuleResolver(resolver, root);
    const dependencies = buildMemoryCache();

    // let vite know about this file
    const viteCacheFile: ZipeScriptTransform = async (c, fp, o) => {
      // cache.has(fp);
      rewriteImports(c, resolver.requestToFile(fp), resolver);
      console.log("vite rewrite", resolver.requestToFile(fp));
      return {
        code: undefined,
        map: undefined,
      };
    };

    const pipeline = buildOutputPipeline(
      dependencies,
      [moduleRewrite, viteCacheFile],
      {}
    );

    let postcssConfig: any = undefined;
    const postcssConfigPromise = loadPostcssConfig(root).then(
      (x) => (postcssConfig = x as any)
    );

    const transforms = { ...scriptTransforms, ...ViteTransformers };

    const sfcParser = buildSFCParser(root, {
      compiler: resolveCompiler(root) as any,
      sfc: {
        sourceMap: true,
      },
      style: {
        preprocessCustomRequire: (id: string) => require(resolve(root, id)),
        ...(postcssConfig
          ? {
              postcssOptions: postcssConfig.options,
              postcssPlugins: postcssConfig.plugins,
            }
          : {}),
      },
      template: {
        compilerOptions: {
          runtimeModuleName: "/@modules/vue",
        },
        preprocessCustomRequire: (id: string) => require(resolve(root, id)),
      },
      transformOptions: {
        sourcemap: true,
        root,
      },
    });

    watcher.on("change", async (p) => {
      const requestFile = resolver.fileToRequest(p);
      if (dependencies.has(requestFile)) {
        // console.log("dep changed", requestFile);
        // const prev = dependencies.get(requestFile)!;
        // const externals = new Map<string, ZipeDependency>();
        // console.log(prev);
        // await parse(p, resolver, dependencies, externals, root);

        dependencies.delete(requestFile);
        console.log("changed", p);
        const module = await parse(
          requestFile,
          "/",
          moduleResolver,
          cache,
          dependencies,
          sfcParser,
          transforms
        );

        // const pathSet = dependencyMap.get(p);
        // if (!pathSet) {
        //   return;
        // }
        // for (const outdatedPath of pathSet) {
        //   console.log("[cache] clearing cache", outdatedPath);
        //   requestCache.delete(outdatedPath);
        // }
      }
    });

    const builder: ZipeBuilder = async (component) => {
      await postcssConfigPromise;

      return outputSSR(
        component,
        moduleResolver,
        cache,
        dependencies,
        sfcParser,
        pipeline,
        transforms,
        []
      );
    };

    return plugin({
      ...ctx,
      zipeSSR: builder,
    });
  };
  /*

  if (watcher) {
    watcher.on("change", async (p) => {
      const requestFile = resolver.fileToRequest(p);
      if (dependencies.has(requestFile)) {
        // console.log("dep changed", requestFile);
        const prev = dependencies.get(requestFile)!;
        const externals = new Map<string, DependencyPointer>();
        console.log(prev);
        dependencies.delete(requestFile);
        await resolveZipeDependency(p, resolver, dependencies, externals, root);

        const pathSet = dependencyMap.get(p);
        if (!pathSet) {
          return;
        }
        for (const outdatedPath of pathSet) {
          console.log("[cache] clearing cache", outdatedPath);
          requestCache.delete(outdatedPath);
        }
      }
    });
  } else {
    // clear all cache
    dependencyMap.clear();
    dependencies.clear();
  }
  */
}
