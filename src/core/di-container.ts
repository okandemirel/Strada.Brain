/**
 * Simple Dependency Injection Container
 *
 * Provides:
 * - Interface-based registration
 * - Singleton and Transient lifecycles
 * - Lazy initialization
 * - Circular dependency detection
 *
 * NOTE: This container is currently RESERVED / UNUSED in production wiring —
 * `bootstrap.ts` constructs services explicitly rather than resolving them
 * through this container. It is retained (with its internal bugs already fixed
 * and covered by tests) for future migration to container-based DI. Do not
 * assume it participates in the live dependency graph.
 */

export type Lifecycle = "singleton" | "transient" | "scoped";

export interface Registration<T> {
  implementation?: new (...args: unknown[]) => T;
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
    // Also create a registration entry so resolve() (which checks
    // `registrations` first and throws ServiceNotFoundError if absent) can find
    // the pre-built instance without requiring a separate class registration.
    this.registrations.set(interfaceName, { lifecycle: "singleton" });
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

    // Return existing singleton or scoped instance. Use presence (has), not
    // truthiness: an instance legitimately resolved/registered as a falsy value
    // (0, "", false) must not be treated as absent and re-created. Scoped
    // instances are cached per-container (createScope copies registrations into
    // a fresh container), so caching them here honors the documented
    // "same instance within scope" contract.
    if (
      registration.lifecycle === "singleton" ||
      registration.lifecycle === "scoped"
    ) {
      if (this.singletons.has(interfaceName)) {
        return this.singletons.get(interfaceName) as T;
      }
    }

    // Track resolution for circular dependency detection
    this.resolutionStack.push(interfaceName);

    try {
      let instance: T;

      if (registration.factory) {
        instance = registration.factory() as T;
      } else if (registration.implementation) {
        instance = new registration.implementation() as T;
      } else {
        throw new ServiceNotFoundError(interfaceName);
      }

      // Cache singletons and scoped instances (scoped is cached within this
      // container/scope only).
      if (
        registration.lifecycle === "singleton" ||
        registration.lifecycle === "scoped"
      ) {
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
        // Presence check, not truthiness: copy a falsy singleton (0/""/false)
        // into the child scope too.
        if (reg.lifecycle === "singleton" && this.singletons.has(name)) {
          scope.singletons.set(name, this.singletons.get(name));
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
