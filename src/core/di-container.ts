/**
 * Simple Dependency Injection Container
 * 
 * Provides:
 * - Interface-based registration
 * - Singleton and Transient lifecycles
 * - Lazy initialization
 * - Circular dependency detection
 */

export type Lifecycle = "singleton" | "transient" | "scoped";

export interface Registration<T> {
  implementation: new (...args: unknown[]) => T;
  lifecycle: Lifecycle;
  instance?: T;
  factory?: () => T;
}

export class DIContainer {
  private readonly registrations = new Map<string, Registration<unknown>>();
  private readonly singletons = new Map<string, unknown>();
  private readonly resolutionStack: string[] = [];

  /**
   * Register a service with transient lifecycle (new instance each time)
   */
  registerTransient<T>(
    interfaceName: string,
    implementation: new (...args: unknown[]) => T
  ): this {
    this.registrations.set(interfaceName, {
      implementation,
      lifecycle: "transient",
    });
    return this;
  }

  /**
   * Register a service with singleton lifecycle (same instance always)
   */
  registerSingleton<T>(
    interfaceName: string,
    implementation: new (...args: unknown[]) => T
  ): this {
    this.registrations.set(interfaceName, {
      implementation,
      lifecycle: "singleton",
    });
    return this;
  }

  /**
   * Register a singleton using a factory function
   */
  registerSingletonFactory<T>(
    interfaceName: string,
    factory: () => T
  ): this {
    this.registrations.set(interfaceName, {
      implementation: class {} as new (...args: unknown[]) => T,
      lifecycle: "singleton",
      factory,
    });
    return this;
  }

  /**
   * Register a service with scoped lifecycle (same instance within scope)
   */
  registerScoped<T>(
    interfaceName: string,
    implementation: new (...args: unknown[]) => T
  ): this {
    this.registrations.set(interfaceName, {
      implementation,
      lifecycle: "scoped",
    });
    return this;
  }

  /**
   * Register an existing instance (useful for testing)
   */
  registerInstance<T>(interfaceName: string, instance: T): this {
    this.singletons.set(interfaceName, instance);
    return this;
  }

  /**
   * Resolve a service by interface name
   */
  resolve<T>(interfaceName: string): T {
    // Check for circular dependencies
    if (this.resolutionStack.includes(interfaceName)) {
      throw new CircularDependencyError(
        interfaceName,
        this.resolutionStack
      );
    }

    const registration = this.registrations.get(interfaceName);
    if (!registration) {
      throw new ServiceNotFoundError(interfaceName);
    }

    // Return existing singleton
    if (registration.lifecycle === "singleton") {
      const existing = this.singletons.get(interfaceName);
      if (existing) {
        return existing as T;
      }
    }

    // Track resolution for circular dependency detection
    this.resolutionStack.push(interfaceName);

    try {
      let instance: T;

      if (registration.factory) {
        instance = registration.factory() as T;
      } else {
        instance = new registration.implementation() as T;
      }

      // Cache singletons
      if (registration.lifecycle === "singleton") {
        this.singletons.set(interfaceName, instance);
      }

      return instance;
    } finally {
      this.resolutionStack.pop();
    }
  }

  /**
   * Try to resolve a service, return undefined if not registered
   */
  tryResolve<T>(interfaceName: string): T | undefined {
    try {
      return this.resolve<T>(interfaceName);
    } catch {
      return undefined;
    }
  }

  /**
   * Check if a service is registered
   */
  isRegistered(interfaceName: string): boolean {
    return this.registrations.has(interfaceName);
  }

  /**
   * Get all registered service names
   */
  getRegisteredServices(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.registrations.clear();
    this.singletons.clear();
    this.resolutionStack.length = 0;
  }

  /**
   * Create a child scope for scoped services
   */
  createScope(): DIContainer {
    const scope = new DIContainer();
    
    // Copy registrations but not singleton instances
    for (const [name, reg] of this.registrations) {
      if (reg.lifecycle === "scoped") {
        scope.registrations.set(name, { ...reg });
      } else {
        scope.registrations.set(name, reg);
        if (reg.lifecycle === "singleton") {
          const instance = this.singletons.get(name);
          if (instance) {
            scope.singletons.set(name, instance);
          }
        }
      }
    }

    return scope;
  }
}

// ============================================================================
// Errors
// ============================================================================

export class ServiceNotFoundError extends Error {
  constructor(public readonly serviceName: string) {
    super(`Service not registered: ${serviceName}`);
    this.name = "ServiceNotFoundError";
  }
}

export class CircularDependencyError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly resolutionChain: string[]
  ) {
    super(
      `Circular dependency detected: ${resolutionChain.join(" → ")} → ${serviceName}`
    );
    this.name = "CircularDependencyError";
  }
}

// ============================================================================
// Global Container Instance
// ============================================================================

let globalContainer: DIContainer | null = null;

export function getContainer(): DIContainer {
  if (!globalContainer) {
    globalContainer = new DIContainer();
  }
  return globalContainer;
}

export function resetContainer(): void {
  globalContainer = null;
}

export function createContainer(): DIContainer {
  return new DIContainer();
}

// ============================================================================
// Service Keys (for type-safe resolution)
// ============================================================================

export const Services = {
  // Core
  Logger: "Logger",
  Config: "Config",
  
  // Security
  AuthManager: "AuthManager",
  RateLimiter: "RateLimiter",
  PathGuard: "PathGuard",
  SecretSanitizer: "SecretSanitizer",
  ReadOnlyGuard: "ReadOnlyGuard",
  DMPolicy: "DMPolicy",
  
  // AI
  AIProvider: "AIProvider",
  
  // Memory
  MemoryManager: "MemoryManager",
  RAGPipeline: "RAGPipeline",
  EmbeddingProvider: "EmbeddingProvider",
  
  // Tools
  ToolRegistry: "ToolRegistry",
  
  // Channels
  ChannelAdapter: "ChannelAdapter",
  
  // Orchestration
  Orchestrator: "Orchestrator",
  
  // Learning
  LearningPipeline: "LearningPipeline",
  ErrorRecovery: "ErrorRecovery",
  TaskPlanner: "TaskPlanner",
  
  // Dashboard
  MetricsCollector: "MetricsCollector",
  DashboardServer: "DashboardServer",
} as const;

export type ServiceKey = (typeof Services)[keyof typeof Services];
