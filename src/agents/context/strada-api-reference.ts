/**
 * Authoritative Strada.Core API Reference
 *
 * Single source of truth for Strada.Core API surface, verified against
 * real source at /Users/okanunico/Documents/Strada/Strada.Core/.
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
    ecs: "Strada.Core.ECS",
    systems: "Strada.Core.ECS.Systems",
    query: "Strada.Core.ECS.Query",
    jobs: "Strada.Core.ECS.Jobs",
    storage: "Strada.Core.ECS.Storage",
    reactive: "Strada.Core.Reactive",
    world: "Strada.Core.ECS.World",
    di: "Strada.Core.DI",
    diAttributes: "Strada.Core.DI.Attributes",
    modules: "Strada.Core.Modules",
    sync: "Strada.Core.Sync",
    communication: "Strada.Core.Communication",
    patterns: "Strada.Core.Patterns",
    data: "Strada.Core.Data",
    pooling: "Strada.Core.Pooling",
    stateMachine: "Strada.Core.StateMachine",
    logging: "Strada.Core.Logging",
    commands: "Strada.Core.Commands",
    bootstrap: "Strada.Core.Bootstrap",
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
    entityQueryPatterns: {
      single: "EntityQuery.Single<T>()",
      filter: "EntityQuery.Where<T>(Func<T, bool>)",
      withAll: "EntityQuery.WithAll<T1, T2>()",
      withAny: "EntityQuery.WithAny<T1, T2>()",
      withNone: "EntityQuery.WithNone<T>()",
    },
    genericVariants: 8,
  },

  // ── Event Bus Patterns ──────────────────────────────────────────────
  eventBusPatterns: {
    events: {
      publish: "EventBus.Publish<TEvent>(TEvent evt)",
      subscribe: "EventBus.Subscribe<TEvent>(Action<TEvent> handler)",
      unsubscribe: "EventBus.Unsubscribe<TEvent>(Action<TEvent> handler)",
    },
    signals: {
      send: "EventBus.Send<TSignal>(TSignal signal)",
      register: "EventBus.RegisterSignalHandler<TSignal>(Action<TSignal> handler)",
      unregister: "EventBus.UnregisterSignalHandler<TSignal>(Action<TSignal> handler)",
    },
    queries: {
      query: "EventBus.Query<TQuery, TResult>(TQuery query)",
      register: "EventBus.RegisterQueryHandler<TQuery, TResult>(Func<TQuery, TResult> handler)",
      unregister: "EventBus.UnregisterQueryHandler<TQuery, TResult>(Func<TQuery, TResult> handler)",
    },
    async: {
      sendAsync: "EventBus.SendAsync<TSignal>(TSignal signal)",
      queryAsync: "EventBus.QueryAsync<TQuery, TResult>(TQuery query)",
    },
    sequences: {
      pattern: "SignalSequence.Then<T>(Action<T>).ThenIf<T>(Func<T, bool>, Action<T>).Execute()",
    },
  },

  // ── Sync Layer ──────────────────────────────────────────────────────
  syncLayer: {
    mediator: "EntityMediator<TView>",
    bindings: {
      component: "ComponentBinding<TComponent, TView>",
      autoSync: "AutoSyncBinding<TComponent, TView>",
      validated: "ValidatedBinding<TComponent, TView>",
    },
    reactiveOps: [
      "Select",
      "Where",
      "CombineLatest",
      "Computed",
      "BindTwoWay",
      "Throttle",
      "DistinctUntilChanged",
      "Track",
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
    interface: "IPoolable / IPoolable<T>",
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
    assetDb: "AssetDatabase",
    assetRegistry: "AssetRegistry",
    guidLookup: "GuidLookup",
  },

  // ── DI API ──────────────────────────────────────────────────────────
  diApi: {
    fieldInjection: "[Inject] private readonly T _field;",
    registration: {
      service: "builder.RegisterService<TInterface, TImpl>()",
      controller: "builder.RegisterController<T>()",
      model: "builder.RegisterModel<TInterface, TImpl>()",
      factory: "builder.RegisterFactory<TInterface, TImpl>()",
      instance: "builder.RegisterInstance<T>(instance)",
      singleton: "builder.RegisterSingleton<TInterface, TImpl>()",
      transient: "builder.RegisterTransient<TInterface, TImpl>()",
      scoped: "builder.RegisterScoped<TInterface, TImpl>()",
      lazy: "builder.RegisterLazy<T>(Func<T> factory)",
    },
  },

  // ── DI Advanced ─────────────────────────────────────────────────────
  diAdvanced: {
    lockFreeSingleton: "LockFreeSingleton<T>",
    directFactory: "DirectFactory<T>",
    sourceGen: "SourceGeneratedContainer",
    asyncContainer: "IAsyncContainer",
    containerScope: "ContainerScope",
    autoRegister: "[AutoRegister]",
    serviceAttribute: "[Service]",
  },

  // ── Player Loop ─────────────────────────────────────────────────────
  playerLoop: {
    runner: "ILoopRunner",
    wrapper: "PlayerLoopWrapper",
    ecsAdapter: "EcsPlayerLoopAdapter",
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
  },
} as const;
