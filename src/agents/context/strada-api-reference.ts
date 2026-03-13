/**
 * Authoritative Strada.Core API Reference
 *
 * Single source of truth for Strada.Core API surface, verified against
 * real source at /Users/okanunico/Documents/Strada/Strada.Core/.
 *
 * Consumed by: strata-knowledge.ts, system-create.ts, module-create.ts,
 * component-create.ts, strata-analyzer.ts.
 *
 * Any Strada.Core API changes require manual updates here.
 */

export const STRADA_API = {
  namespaces: {
    ecs: "Strada.Core.ECS",
    systems: "Strada.Core.ECS.Systems",
    di: "Strada.Core.DI",
    diAttributes: "Strada.Core.DI.Attributes",
    modules: "Strada.Core.Modules",
    sync: "Strada.Core.Sync",
    communication: "Strada.Core.Communication",
    patterns: "Strada.Core.Patterns",
  },
  baseClasses: {
    systems: ["SystemBase", "JobSystemBase", "BurstSystemBase"] as string[],
  },
  systemApi: {
    abstractMethod: "OnUpdate(float deltaTime)",
    lifecycleMethods: ["OnInitialize()", "OnDispose()"],
    queryPattern: "ForEach<T1, T2>((int entity, ref T1 c1, ref T2 c2) => { })",
    orderAttribute: "[SystemOrder(int)]",
    genericVariants: 8,
  },
  diApi: {
    fieldInjection: "[Inject] private readonly T _field;",
    registration: {
      service: "builder.RegisterService<TInterface, TImpl>()",
      controller: "builder.RegisterController<T>()",
      model: "builder.RegisterModel<TInterface, TImpl>()",
      factory: "builder.RegisterFactory<TInterface, TImpl>()",
      instance: "builder.RegisterInstance<T>(instance)",
    },
  },
  componentApi: {
    interface: "IComponent",
    structLayout: "[StructLayout(LayoutKind.Sequential)]",
    constraint: "unmanaged",
  },
} as const;
