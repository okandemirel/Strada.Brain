/**
 * Authoritative Strada.Core API Reference
 *
 * @deprecated This static reference is superseded by the Framework Knowledge Layer
 * (FrameworkSchemaProvider). It is retained as fallback data when the live
 * knowledge store has no data. New code should use getFrameworkSchemaProvider()
 * from src/intelligence/framework/index.ts.
 *
 * Single source of truth for Strada.Core API surface, verified against
 * a real Strada.Core source checkout during sync/audit workflows.
 *
 * Consumed by: strada-knowledge.ts, system-create.ts, module-create.ts,
 * component-create.ts, mediator-create.ts, strada-analyzer.ts.
 *
 * Any Strada.Core API changes require manual updates here.
 *
 * Coverage: namespaces, base classes, system attributes, update phases,
 * system API, DI, components, event bus, sync layer, pooling, logging,
 * editor tools, data layer, advanced DI, player loop, assemblies.
 */

export const STRADA_API = {
  // ── Namespaces ──────────────────────────────────────────────────────
  namespaces: {
    core: "Strada.Core.Core",
    ecs: "Strada.Core.ECS",
    ecsArchetypes: "Strada.Core.ECS.Archetypes",
    ecsCore: "Strada.Core.ECS.Core",
    systems: "Strada.Core.ECS.Systems",
    query: "Strada.Core.ECS.Query",
    jobs: "Strada.Core.ECS.Jobs",
    storage: "Strada.Core.ECS.Storage",
    reactive: "Strada.Core.ECS.Reactive",
    world: "Strada.Core.ECS.World",
    di: "Strada.Core.DI",
    diAttributes: "Strada.Core.DI.Attributes",
    diAutoBinding: "Strada.Core.DI.AutoBinding",
    modules: "Strada.Core.Modules",
    sync: "Strada.Core.Sync",
    communication: "Strada.Core.Communication",
    patterns: "Strada.Core.Patterns",
    patternsInterfaces: "Strada.Core.Patterns.Interfaces",
    data: "Strada.Core.Data",
    pooling: "Strada.Core.Pooling",
    stateMachine: "Strada.Core.StateMachine",
    logging: "Strada.Core.Logging",
    services: "Strada.Core.Services",
    utilities: "Strada.Core.Utilities",
    sourceGen: "Strada.SourceGeneration",
    commands: "Strada.Core.Commands",
    bootstrap: "Strada.Core.Bootstrap",
    editor: "Strada.Core.Editor",
    editorBenchmarking: "Strada.Core.Editor.Benchmarking",
    editorCodeGen: "Strada.Core.Editor.CodeGen",
    editorDataProviders: "Strada.Core.Editor.DataProviders",
    editorDataProvidersModels: "Strada.Core.Editor.DataProviders.Models",
    editorGraph: "Strada.Core.Editor.Graph",
    editorHotReload: "Strada.Core.Editor.HotReload",
    editorInspectors: "Strada.Core.Editor.Inspectors",
    editorModuleGenerator: "Strada.Core.Editor.ModuleGenerator",
    editorModuleGeneratorConfig: "Strada.Core.Editor.ModuleGenerator.Config",
    editorModuleGeneratorModels: "Strada.Core.Editor.ModuleGenerator.Models",
    editorModuleGeneratorPipeline: "Strada.Core.Editor.ModuleGenerator.Pipeline",
    editorModuleGeneratorPipelineSteps: "Strada.Core.Editor.ModuleGenerator.Pipeline.Steps",
    editorProfiling: "Strada.Core.Editor.Profiling",
    editorPropertyDrawers: "Strada.Core.Editor.PropertyDrawers",
    editorSettings: "Strada.Core.Editor.Settings",
    editorTemplates: "Strada.Core.Editor.Templates",
    editorUtilities: "Strada.Core.Editor.Utilities",
    editorValidation: "Strada.Core.Editor.Validation",
    editorWindows: "Strada.Core.Editor.Windows",
  },

  // ── Base Classes ────────────────────────────────────────────────────
  baseClasses: {
    /** Plain system base classes — used by strada-analyzer for detection */
    systems: ["SystemBase", "JobSystemBase"] as string[],

    /** Generic BurstSystem variants (1–4 component type args) */
    burstSystemVariants: [
      "BurstSystem<TJob, T1>",
      "BurstSystem<TJob, T1, T2>",
      "BurstSystem<TJob, T1, T2, T3>",
      "BurstSystem<TJob, T1, T2, T3, T4>",
    ],

    /** MVC/pattern base classes */
    patterns: [
      "Controller",
      "Controller<TModel>",
      "TickableController",
      "FixedTickableController",
      "FullTickController",
      "Service",
      "TickableService",
      "FixedTickableService",
      "OrderedService",
      "View",
      "Model",
      "Base",
    ],
  },

  // ── System Attributes ───────────────────────────────────────────────
  systemAttributes: {
    stradaSystem: "[StradaSystem]",
    executionOrder: "[ExecutionOrder(0)]",
    updatePhase: "[UpdatePhase(UpdatePhase.Update)]",
    runBefore: "[RunBefore(typeof(OtherSystem))]",
    runAfter: "[RunAfter(typeof(OtherSystem))]",
    requiresSystem: "[RequiresSystem(typeof(OtherSystem))]",
    systemCategory: "[SystemCategory(string)]",
    systemDescription: "[SystemDescription(string)]",
  },

  // ── Update Phases ───────────────────────────────────────────────────
  updatePhases: [
    "Initialization",
    "Update",
    "LateUpdate",
    "FixedUpdate",
  ] as string[],

  // ── System API ──────────────────────────────────────────────────────
  systemApi: {
    abstractMethod: "protected override void OnUpdate(float deltaTime)",
    lifecycleMethods: [
      "OnInitialize()",
      "OnDispose()",
    ],
    queryPattern: "ForEach<T1, T2>((int entity, ref T1 c1, ref T2 c2) => { })",
    // Query() on a system; there is no WithAll/WithAny/WithNone builder.
    queryBuilder: {
      query: "Query()",
      select: "QueryBuilder.Select<T1, T2>()",
      filter: "QueryBuilder.Filter<T1>()",
      also: "FilteredQueryBuilder.Also<TFilter>()",
      none: "FilteredQueryBuilder.None<TExclude>()",
      forEach: "FilteredQueryBuilder.ForEach(QueryDelegate<T1> action)",
    },
    genericVariants: 8,
  },

  // ── Event Bus Patterns ──────────────────────────────────────────────
  eventBusPatterns: {
    events: {
      publish: "EventBus.Publish<TEvent>(TEvent evt)",
      subscribe: "EventBus.Subscribe<TEvent>(Action<TEvent> handler)",
    },
    signals: {
      send: "EventBus.Send<TSignal>(TSignal signal)",
      register: "EventBus.RegisterSignalHandler<TSignal>(Action<TSignal> handler)",
    },
    queries: {
      query: "EventBus.Query<TQuery, TResult>(TQuery query)",
      register: "EventBus.RegisterQueryHandler<TQuery, TResult>(Func<TQuery, TResult> handler)",
      contract: "IQuery<TResult>",
    },
    // Every Register*/Subscribe returns one; the bus has no Unsubscribe/Unregister*.
    unsubscribe: "SubscriptionToken.Dispose()",
    async: {
      sendAsync: "EventBus.SendAsync<TSignal>(TSignal signal)",
      queryAsync: "EventBus.QueryAsync<TQuery, TResult>(TQuery query)",
      queryContract: "IAsyncQuery<TResult>",
    },
    sequences: {
      pattern: "new SignalSequence(bus).Then<TSignal>(TSignal signal).ThenIf<TSignal>(Func<bool> predicate, TSignal signal).Execute()",
    },
  },

  // ── Sync Layer ──────────────────────────────────────────────────────
  syncLayer: {
    mediator: "EntityMediator<TView>",
    // The operators below extend IReadOnlyReactiveProperty<T>; Computed and
    // BindTwoWay belong to BindingScope.
    reactiveProperty: "ReactiveProperty<T>",
    bindingScope: "BindingScope",
    bindings: {
      component: "ComponentBinding<TComponent, TProperty>",
      autoSync: "AutoSyncBinding<TComponent>",
      validated: "ValidatedBinding<T>",
    },
    reactiveOps: [
      "Select",
      "Where",
      "CombineLatest",
      "Computed",
      "BindTwoWay",
      "Throttle",
      "DistinctUntilChanged",
    ],
    properties: {
      mapped: "MappedProperty<TSource, TResult>",
      filtered: "FilteredProperty<T>",
      combined: "CombinedProperty<T1, T2, TResult>",
      throttled: "ThrottledProperty<T>",
    },
  },

  // ── Pooling ─────────────────────────────────────────────────────────
  pooling: {
    pool: "ObjectPool<T>",
    registry: "PoolRegistry",
    interface: "IPoolable",
    methods: [
      "Spawn()",
      "Despawn(T)",
      "Prewarm(count)",
    ],
  },

  // ── Logging ─────────────────────────────────────────────────────────
  logging: {
    logger: "StradaLog",
    module: "LogModule",
    methods: [
      "Log()",
      "LogWarning()",
      "LogError()",
      "LogException()",
      "LogDeep()",
    ],
  },

  // ── Editor Tools ────────────────────────────────────────────────────
  editorTools: {
    validator: "ArchitectureValidator",
    hotReload: "HotReloadManager",
    profiler: "SystemProfiler",
    benchmark: "BenchmarkRunner",
  },

  // ── Data Layer ──────────────────────────────────────────────────────
  dataLayer: {
    configDb: "ConfigDatabase",
    assetDb: "RuntimeAssetDatabase",
    assetRegistry: "AssetRegistry",
  },

  // ── DI API ──────────────────────────────────────────────────────────
  diApi: {
    // Constructor parameters are resolved everywhere; [Inject] members only by
    // newer Core builds, and only for RegisterController<T>() and
    // RegisterService<…>() registrations (the others only construct).
    constructorInjection: "constructor parameters, resolved by the container",
    fieldInjection: "[Inject] private readonly T _field;",
    registration: {
      service: "builder.RegisterService<TInterface, TImpl>()",
      controller: "builder.RegisterController<T>()",
      model: "builder.RegisterModel<TInterface, TImpl>()",
      factory: "builder.RegisterFactory<T>(Func<IServiceLocator, T> factory, Lifetime lifetime)",
      instance: "builder.RegisterInstance<T>(instance)",
      // There is no RegisterSingleton/RegisterTransient/RegisterScoped/RegisterLazy.
      withLifetime: "builder.Register<TInterface, TImpl>(Lifetime lifetime)",
      lifetimes: "Lifetime.Singleton | Lifetime.Transient | Lifetime.Scoped",
    },
  },

  // ── DI Advanced ─────────────────────────────────────────────────────
  diAdvanced: {
    directFactory: "DirectFactory<T>",
    sourceGen: "Strada.SourceGeneration",
    asyncScope: "AsyncContainerScope",
    containerScope: "ContainerScope",
    autoRegister: "[AutoRegister]",
    autoRegisterSingleton: "[AutoRegisterSingleton]",
    autoRegisterTransient: "[AutoRegisterTransient]",
    autoRegisterScoped: "[AutoRegisterScoped]",
  },

  // ── Player Loop ─────────────────────────────────────────────────────
  playerLoop: {
    runner: "ILoopRunner",
    apiClass: "PlayerLoop",
  },

  // ── Component API ───────────────────────────────────────────────────
  componentApi: {
    interface: "IComponent",
    structLayout: "[StructLayout(LayoutKind.Sequential)]",
    constraint: "unmanaged",
  },

  // ── Assembly References ─────────────────────────────────────────────
  assemblyReferences: {
    core: "Strada.Core",
    burst: "Unity.Burst",
    collections: "Unity.Collections",
    mathematics: "Unity.Mathematics",
    entities: "Unity.Entities",
  },
} as const;
