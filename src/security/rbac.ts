/**
 * Role-Based Access Control (RBAC) for Strata.Brain
 * 
 * Provides:
 * - Role hierarchy
 * - Permission matrix
 * - Resource-based authorization
 * - Policy-based access control
 * - Context-aware authorization
 */

import { getLogger } from "../utils/logger.js";
import type { User, UserRole, Permission } from "./auth-hardened.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface Resource {
  type: ResourceType;
  id: string;
  owner?: string;
  project?: string;
  organization?: string;
  metadata?: Record<string, unknown>;
}

export type ResourceType =
  | "file"
  | "directory"
  | "project"
  | "system"
  | "config"
  | "user"
  | "session"
  | "agent"
  | "memory"
  | "log"
  | "shell_command"
  | "api_key"
  | "webhook";

export type Action =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "execute"
  | "list"
  | "manage"
  | "share"
  | "admin";

export interface AccessContext {
  user: User;
  resource: Resource;
  action: Action;
  requestContext?: {
    ipAddress?: string;
    userAgent?: string;
    timestamp?: number;
    requestId?: string;
  };
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
  policy?: string;
  matchedConditions?: string[];
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  priority: number;
  conditions: PolicyCondition[];
  effect: "allow" | "deny";
  resources?: ResourcePattern[];
  actions?: Action[];
  roles?: UserRole[];
  permissions?: Permission[];
}

export interface PolicyCondition {
  type: "role" | "permission" | "ownership" | "time" | "ip" | "custom";
  operator: "equals" | "contains" | "in" | "not_in" | "starts_with" | "regex" | "custom";
  field?: string;
  value: unknown;
  customCheck?: (context: AccessContext) => boolean;
}

export interface ResourcePattern {
  type: ResourceType | "*";
  pattern: string; // Glob pattern or regex
  matchType: "exact" | "glob" | "regex";
}

// =============================================================================
// ROLE HIERARCHY
// =============================================================================

export const ROLE_HIERARCHY: Record<UserRole, UserRole[]> = {
  superadmin: [],
  admin: ["superadmin"],
  developer: ["admin", "superadmin"],
  viewer: ["developer", "admin", "superadmin"],
  service: ["viewer", "developer", "admin", "superadmin"],
};

/**
 * Check if a role inherits from another role
 */
export function roleInherits(role: UserRole, parentRole: UserRole): boolean {
  const parents = ROLE_HIERARCHY[role];
  if (parents.includes(parentRole)) return true;
  return parents.some((p) => roleInherits(p as UserRole, parentRole));
}

/**
 * Get all roles that a role inherits from (transitive)
 */
export function getInheritedRoles(role: UserRole): UserRole[] {
  const inherited: UserRole[] = [];
  const toProcess = [...ROLE_HIERARCHY[role]];
  
  while (toProcess.length > 0) {
    const current = toProcess.pop() as UserRole;
    if (!inherited.includes(current)) {
      inherited.push(current);
      toProcess.push(...ROLE_HIERARCHY[current]);
    }
  }
  
  return inherited;
}

// =============================================================================
// PERMISSION MATRIX
// =============================================================================

interface PermissionMatrixEntry {
  resource: ResourceType;
  action: Action;
  minRole: UserRole;
  requiresOwnership: boolean;
  conditions?: PolicyCondition[];
}

export const PERMISSION_MATRIX: PermissionMatrixEntry[] = [
  // File operations
  { resource: "file", action: "read", minRole: "viewer", requiresOwnership: false },
  { resource: "file", action: "create", minRole: "developer", requiresOwnership: false },
  { resource: "file", action: "update", minRole: "developer", requiresOwnership: false },
  { resource: "file", action: "delete", minRole: "admin", requiresOwnership: false },
  
  // Directory operations
  { resource: "directory", action: "read", minRole: "viewer", requiresOwnership: false },
  { resource: "directory", action: "create", minRole: "developer", requiresOwnership: false },
  { resource: "directory", action: "delete", minRole: "admin", requiresOwnership: false },
  
  // System operations
  { resource: "system", action: "read", minRole: "viewer", requiresOwnership: false },
  { resource: "system", action: "execute", minRole: "developer", requiresOwnership: false },
  { resource: "system", action: "manage", minRole: "admin", requiresOwnership: false },
  { resource: "system", action: "admin", minRole: "superadmin", requiresOwnership: false },
  
  // Config operations
  { resource: "config", action: "read", minRole: "viewer", requiresOwnership: false },
  { resource: "config", action: "update", minRole: "admin", requiresOwnership: false },
  
  // Shell operations
  { resource: "shell_command", action: "execute", minRole: "developer", requiresOwnership: false },
  
  // User management
  { resource: "user", action: "read", minRole: "admin", requiresOwnership: false },
  { resource: "user", action: "create", minRole: "admin", requiresOwnership: false },
  { resource: "user", action: "update", minRole: "admin", requiresOwnership: true },
  { resource: "user", action: "delete", minRole: "superadmin", requiresOwnership: false },
  
  // Agent operations
  { resource: "agent", action: "read", minRole: "viewer", requiresOwnership: false },
  { resource: "agent", action: "create", minRole: "developer", requiresOwnership: false },
  { resource: "agent", action: "execute", minRole: "developer", requiresOwnership: false },
  { resource: "agent", action: "manage", minRole: "admin", requiresOwnership: false },
  
  // Memory operations
  { resource: "memory", action: "read", minRole: "viewer", requiresOwnership: false },
  { resource: "memory", action: "create", minRole: "developer", requiresOwnership: false },
  { resource: "memory", action: "update", minRole: "developer", requiresOwnership: false },
  { resource: "memory", action: "delete", minRole: "admin", requiresOwnership: false },
  
  // Log operations
  { resource: "log", action: "read", minRole: "admin", requiresOwnership: false },
  
  // API Key operations
  { resource: "api_key", action: "create", minRole: "admin", requiresOwnership: false },
  { resource: "api_key", action: "read", minRole: "admin", requiresOwnership: true },
  { resource: "api_key", action: "delete", minRole: "admin", requiresOwnership: true },
];

// =============================================================================
// POLICY ENGINE
// =============================================================================

export class PolicyEngine {
  private policies: Policy[] = [];
  private readonly logger = getLogger();

  /**
   * Add a policy
   */
  addPolicy(policy: Policy): void {
    this.policies.push(policy);
    this.policies.sort((a, b) => b.priority - a.priority);
    this.logger.info("Policy added", { policyId: policy.id, name: policy.name });
  }

  /**
   * Remove a policy
   */
  removePolicy(policyId: string): boolean {
    const index = this.policies.findIndex((p) => p.id === policyId);
    if (index >= 0) {
      this.policies.splice(index, 1);
      this.logger.info("Policy removed", { policyId });
      return true;
    }
    return false;
  }

  /**
   * Evaluate policies for access context
   */
  evaluate(context: AccessContext): AuthorizationResult {
    const matchedConditions: string[] = [];

    for (const policy of this.policies) {
      // Check if policy applies to this resource
      if (policy.resources && !this.matchesResourcePattern(context.resource, policy.resources)) {
        continue;
      }

      // Check if policy applies to this action
      if (policy.actions && !policy.actions.includes(context.action)) {
        continue;
      }

      // Check if policy applies to this role
      if (policy.roles && !policy.roles.includes(context.user.role)) {
        continue;
      }

      // Check if policy applies to this permission
      if (policy.permissions && 
          !policy.permissions.some((p) => context.user.permissions.includes(p))) {
        continue;
      }

      // Evaluate conditions
      const conditionsMet = policy.conditions.every((condition) => {
        const met = this.evaluateCondition(condition, context);
        if (met) {
          matchedConditions.push(`${policy.id}:${condition.type}`);
        }
        return met;
      });

      if (conditionsMet) {
        return {
          allowed: policy.effect === "allow",
          reason: `Policy ${policy.id} (${policy.name}) ${policy.effect === "allow" ? "grants" : "denies"} access`,
          policy: policy.id,
          matchedConditions,
        };
      }
    }

    // Default deny if no policy matches
    return {
      allowed: false,
      reason: "No matching policy found - default deny",
      matchedConditions,
    };
  }

  private evaluateCondition(condition: PolicyCondition, context: AccessContext): boolean {
    switch (condition.type) {
      case "role":
        return this.evaluateRoleCondition(condition, context);
      case "permission":
        return this.evaluatePermissionCondition(condition, context);
      case "ownership":
        return this.evaluateOwnershipCondition(condition, context);
      case "time":
        return this.evaluateTimeCondition(condition);
      case "ip":
        return this.evaluateIpCondition(condition, context);
      case "custom":
        return condition.customCheck?.(context) ?? false;
      default:
        return false;
    }
  }

  private evaluateRoleCondition(condition: PolicyCondition, context: AccessContext): boolean {
    const userRole = context.user.role;
    const requiredRole = condition.value as UserRole;

    switch (condition.operator) {
      case "equals":
        return userRole === requiredRole;
      case "in":
        return (condition.value as UserRole[]).includes(userRole);
      case "not_in":
        return !(condition.value as UserRole[]).includes(userRole);
      default:
        return false;
    }
  }

  private evaluatePermissionCondition(condition: PolicyCondition, context: AccessContext): boolean {
    const hasPermission = context.user.permissions.includes(condition.value as Permission);
    return condition.operator === "equals" ? hasPermission : !hasPermission;
  }

  private evaluateOwnershipCondition(condition: PolicyCondition, context: AccessContext): boolean {
    const isOwner = context.resource.owner === context.user.id;
    return condition.value === true ? isOwner : !isOwner;
  }

  private evaluateTimeCondition(condition: PolicyCondition): boolean {
    const now = new Date();
    const timeConfig = condition.value as { start?: string; end?: string; days?: number[] };

    if (timeConfig.start && timeConfig.end) {
      const start = new Date(timeConfig.start);
      const end = new Date(timeConfig.end);
      if (now < start || now > end) return false;
    }

    if (timeConfig.days) {
      if (!timeConfig.days.includes(now.getDay())) return false;
    }

    return true;
  }

  private evaluateIpCondition(condition: PolicyCondition, context: AccessContext): boolean {
    const clientIp = context.requestContext?.ipAddress;
    if (!clientIp) return false;

    const allowedIps = condition.value as string[];
    return allowedIps.includes(clientIp);
  }

  private matchesResourcePattern(resource: Resource, patterns: ResourcePattern[]): boolean {
    return patterns.some((pattern) => {
      if (pattern.type !== "*" && pattern.type !== resource.type) {
        return false;
      }

      switch (pattern.matchType) {
        case "exact":
          return resource.id === pattern.pattern;
        case "glob":
          return this.globMatch(resource.id, pattern.pattern);
        case "regex":
          return new RegExp(pattern.pattern).test(resource.id);
        default:
          return false;
      }
    });
  }

  private globMatch(str: string, pattern: string): boolean {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    );
    return regex.test(str);
  }

  /**
   * Get all policies
   */
  getPolicies(): Policy[] {
    return [...this.policies];
  }
}

// =============================================================================
// RBAC MANAGER
// =============================================================================

export class RbacManager {
  private readonly policyEngine: PolicyEngine;
  private readonly resourceOwners = new Map<string, string>();
  private readonly logger = getLogger();

  constructor() {
    this.policyEngine = new PolicyEngine();
    this.initializeDefaultPolicies();
  }

  /**
   * Check if user can perform action on resource
   */
  authorize(context: AccessContext): AuthorizationResult {
    // 1. Check permission matrix
    const matrixResult = this.checkPermissionMatrix(context);
    if (!matrixResult.allowed) {
      return matrixResult;
    }

    // 2. Evaluate custom policies
    const policyResult = this.policyEngine.evaluate(context);
    if (!policyResult.allowed) {
      return policyResult;
    }

    // 3. Log authorization success
    this.logger.debug("Authorization granted", {
      userId: context.user.id,
      resource: `${context.resource.type}:${context.resource.id}`,
      action: context.action,
    });

    return {
      allowed: true,
      reason: policyResult.reason || matrixResult.reason,
      policy: policyResult.policy,
    };
  }

  /**
   * Quick permission check
   */
  hasPermission(user: User, permission: Permission): boolean {
    if (user.permissions.includes("system:full")) return true;
    return user.permissions.includes(permission);
  }

  /**
   * Check resource ownership
   */
  isOwner(userId: string, resource: Resource): boolean {
    if (resource.owner) {
      return resource.owner === userId;
    }
    const storedOwner = this.resourceOwners.get(`${resource.type}:${resource.id}`);
    return storedOwner === userId;
  }

  /**
   * Set resource owner
   */
  setResourceOwner(resource: Resource, ownerId: string): void {
    this.resourceOwners.set(`${resource.type}:${resource.id}`, ownerId);
  }

  /**
   * Add custom policy
   */
  addPolicy(policy: Policy): void {
    this.policyEngine.addPolicy(policy);
  }

  /**
   * Remove policy
   */
  removePolicy(policyId: string): boolean {
    return this.policyEngine.removePolicy(policyId);
  }

  /**
   * Get role rank (higher = more permissions)
   */
  getRoleRank(role: UserRole): number {
    const ranks: Record<UserRole, number> = {
      superadmin: 100,
      admin: 80,
      developer: 60,
      viewer: 40,
      service: 20,
    };
    return ranks[role];
  }

  /**
   * Check if role has sufficient rank
   */
  hasMinimumRole(userRole: UserRole, requiredRole: UserRole): boolean {
    return this.getRoleRank(userRole) >= this.getRoleRank(requiredRole);
  }

  private checkPermissionMatrix(context: AccessContext): AuthorizationResult {
    const entry = PERMISSION_MATRIX.find(
      (e) => e.resource === context.resource.type && e.action === context.action
    );

    if (!entry) {
      return { allowed: false, reason: "No permission matrix entry found" };
    }

    // Check role requirement
    if (!this.hasMinimumRole(context.user.role, entry.minRole)) {
      return {
        allowed: false,
        reason: `Requires ${entry.minRole} role or higher`,
      };
    }

    // Check ownership requirement
    if (entry.requiresOwnership && !this.isOwner(context.user.id, context.resource)) {
      return {
        allowed: false,
        reason: "Resource ownership required",
      };
    }

    return { allowed: true, reason: "Permission matrix allows access" };
  }

  private initializeDefaultPolicies(): void {
    // Default deny policy (lowest priority)
    this.policyEngine.addPolicy({
      id: "default-deny",
      name: "Default Deny",
      description: "Deny all access by default",
      priority: 0,
      conditions: [{ type: "custom", operator: "custom", value: true, customCheck: () => true }],
      effect: "deny",
    });

    // Superadmin bypass (highest priority)
    this.policyEngine.addPolicy({
      id: "superadmin-bypass",
      name: "Superadmin Bypass",
      description: "Superadmins bypass all restrictions",
      priority: 1000,
      conditions: [
        { type: "role", operator: "equals", value: "superadmin" },
      ],
      effect: "allow",
    });

    // Ownership policy
    this.policyEngine.addPolicy({
      id: "ownership-policy",
      name: "Ownership Policy",
      description: "Resource owners have full access to their resources",
      priority: 500,
      conditions: [
        { type: "ownership", operator: "equals", value: true },
      ],
      effect: "allow",
    });
  }
}

// =============================================================================
// ATTRIBUTE-BASED ACCESS CONTROL (ABAC)
// =============================================================================

export interface AbacAttributes {
  subject: Record<string, unknown>;
  resource: Record<string, unknown>;
  action: Record<string, unknown>;
  environment: Record<string, unknown>;
}

export class AbacEngine {
  private attributeRules: Array<{
    id: string;
    condition: (attrs: AbacAttributes) => boolean;
    effect: "allow" | "deny";
  }> = [];

  /**
   * Add an attribute-based rule
   */
  addRule(
    id: string,
    condition: (attrs: AbacAttributes) => boolean,
    effect: "allow" | "deny"
  ): void {
    this.attributeRules.push({ id, condition, effect });
  }

  /**
   * Evaluate attributes against rules
   */
  evaluate(attributes: AbacAttributes): AuthorizationResult {
    for (const rule of this.attributeRules) {
      if (rule.condition(attributes)) {
        return {
          allowed: rule.effect === "allow",
          reason: `ABAC rule ${rule.id} ${rule.effect}s access`,
        };
      }
    }

    return { allowed: false, reason: "No ABAC rule matched" };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export const rbacManager = new RbacManager();
export const abacEngine = new AbacEngine();
