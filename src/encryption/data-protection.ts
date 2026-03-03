/**
 * Data Protection Module for Strata.Brain
 * 
 * Provides:
 * - Encryption at rest (AES-256-GCM)
 * - Encryption in transit helpers
 * - Key management
 * - Secure key rotation
 * - Data masking and tokenization
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import type { CipherGCM, DecipherGCM } from "node:crypto";
import { getLogger } from "../utils/logger.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface EncryptedData {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  salt: Buffer;
  version: number;
}

export interface EncryptedString {
  data: string;
  iv: string;
  authTag: string;
  salt: string;
  version: number;
}

export interface DataEncryptionKey {
  id: string;
  key: Buffer;
  createdAt: number;
  expiresAt?: number;
  status: "active" | "rotating" | "retired";
  algorithm: string;
}

export interface KeyRotationPolicy {
  rotationInterval: number; // milliseconds
  notifyBefore: number; // milliseconds before rotation
  retireAfter: number; // milliseconds after rotation
}

export interface MaskingOptions {
  type: "full" | "partial" | "email" | "credit_card" | "ssn" | "phone";
  maskChar?: string;
  showFirst?: number;
  showLast?: number;
}

export interface TokenMapping {
  token: string;
  original: string;
  createdAt: number;
  expiresAt?: number;
}

// =============================================================================
// ENCRYPTION CONFIGURATION
// =============================================================================

const ENCRYPTION_CONFIG = {
  algorithm: "aes-256-gcm",
  keyLength: 32,
  ivLength: 16,
  authTagLength: 16,
  saltLength: 32,
  iterations: 100000,
  currentVersion: 1,
};

// =============================================================================
// KEY MANAGER
// =============================================================================

export class KeyManager {
  private readonly keys = new Map<string, DataEncryptionKey>();
  private currentKeyId: string | null = null;
  private readonly rotationPolicy: KeyRotationPolicy;
  private readonly logger = getLogger();
  private rotationTimer: NodeJS.Timeout | null = null;

  constructor(
    masterKey?: string,
    rotationPolicy: Partial<KeyRotationPolicy> = {}
  ) {
    this.rotationPolicy = {
      rotationInterval: 90 * 24 * 60 * 60 * 1000, // 90 days
      notifyBefore: 7 * 24 * 60 * 60 * 1000, // 7 days
      retireAfter: 30 * 24 * 60 * 60 * 1000, // 30 days
      ...rotationPolicy,
    };

    if (masterKey) {
      this.initializeWithMasterKey(masterKey);
    }

    this.startRotationTimer();
  }

  /**
   * Initialize with a master key
   */
  private initializeWithMasterKey(masterKey: string): void {
    const keyData = this.deriveKey(masterKey, randomBytes(ENCRYPTION_CONFIG.saltLength));
    
    const dek: DataEncryptionKey = {
      id: this.generateKeyId(),
      key: keyData.key,
      createdAt: Date.now(),
      status: "active",
      algorithm: ENCRYPTION_CONFIG.algorithm,
    };

    this.keys.set(dek.id, dek);
    this.currentKeyId = dek.id;

    this.logger.info("Key manager initialized", { keyId: dek.id });
  }

  /**
   * Generate a new data encryption key
   */
  generateKey(): DataEncryptionKey {
    const dek: DataEncryptionKey = {
      id: this.generateKeyId(),
      key: randomBytes(ENCRYPTION_CONFIG.keyLength),
      createdAt: Date.now(),
      status: "active",
      algorithm: ENCRYPTION_CONFIG.algorithm,
    };

    this.keys.set(dek.id, dek);
    this.currentKeyId = dek.id;

    this.logger.info("New encryption key generated", { keyId: dek.id });

    return dek;
  }

  /**
   * Get current active key
   */
  getCurrentKey(): DataEncryptionKey | null {
    if (!this.currentKeyId) return null;
    return this.keys.get(this.currentKeyId) || null;
  }

  /**
   * Get key by ID
   */
  getKey(keyId: string): DataEncryptionKey | undefined {
    return this.keys.get(keyId);
  }

  /**
   * Rotate keys
   */
  rotateKeys(): DataEncryptionKey {
    // Mark current key as rotating
    const currentKey = this.getCurrentKey();
    if (currentKey) {
      currentKey.status = "rotating";
      
      // Schedule retirement
      setTimeout(() => {
        currentKey.status = "retired";
        this.logger.info("Key retired", { keyId: currentKey.id });
      }, this.rotationPolicy.retireAfter);
    }

    // Generate new key
    return this.generateKey();
  }

  /**
   * Schedule key rotation
   */
  scheduleRotation(callback?: (newKey: DataEncryptionKey) => void): void {
    const currentKey = this.getCurrentKey();
    if (!currentKey) return;

    const nextRotation = currentKey.createdAt + this.rotationPolicy.rotationInterval;
    const notifyAt = nextRotation - this.rotationPolicy.notifyBefore;
    const now = Date.now();

    // Schedule notification
    if (notifyAt > now) {
      setTimeout(() => {
        this.logger.warn("Key rotation approaching", {
          keyId: currentKey.id,
          rotationAt: new Date(nextRotation).toISOString(),
        });
      }, notifyAt - now);
    }

    // Schedule rotation
    if (nextRotation > now) {
      setTimeout(() => {
        const newKey = this.rotateKeys();
        callback?.(newKey);
      }, nextRotation - now);
    }
  }

  /**
   * Export key (for backup - encrypt this!)
   */
  exportKey(keyId: string): { id: string; key: string; createdAt: number } | null {
    const key = this.keys.get(keyId);
    if (!key) return null;

    return {
      id: key.id,
      key: key.key.toString("base64"),
      createdAt: key.createdAt,
    };
  }

  /**
   * Import key
   */
  importKey(id: string, keyBase64: string, createdAt: number): DataEncryptionKey {
    const dek: DataEncryptionKey = {
      id,
      key: Buffer.from(keyBase64, "base64"),
      createdAt,
      status: "active",
      algorithm: ENCRYPTION_CONFIG.algorithm,
    };

    this.keys.set(id, dek);
    return dek;
  }

  /**
   * Get all keys
   */
  getAllKeys(): DataEncryptionKey[] {
    return Array.from(this.keys.values());
  }

  /**
   * Destroy all keys
   */
  destroy(): void {
    // Overwrite key buffers
    for (const key of Array.from(this.keys.values())) {
      key.key.fill(0);
    }
    this.keys.clear();
    this.currentKeyId = null;
    
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
    }

    this.logger.info("Key manager destroyed");
  }

  private deriveKey(password: string, salt: Buffer): { key: Buffer; salt: Buffer } {
    const key = scryptSync(password, salt, ENCRYPTION_CONFIG.keyLength, {
      N: ENCRYPTION_CONFIG.iterations,
    });
    return { key, salt };
  }

  private generateKeyId(): string {
    return `dek-${Date.now()}-${randomBytes(4).toString("hex")}`;
  }

  private startRotationTimer(): void {
    // Check for rotations every hour
    this.rotationTimer = setInterval(() => {
      this.scheduleRotation();
    }, 60 * 60 * 1000);
  }
}

// =============================================================================
// ENCRYPTION SERVICE
// =============================================================================

export class EncryptionService {
  private readonly keyManager: KeyManager;
  private readonly logger = getLogger();

  constructor(keyManager: KeyManager) {
    this.keyManager = keyManager;
  }

  /**
   * Encrypt data with AES-256-GCM
   */
  encrypt(plaintext: Buffer | string, keyId?: string): EncryptedData {
    const key = keyId 
      ? this.keyManager.getKey(keyId)?.key 
      : this.keyManager.getCurrentKey()?.key;

    if (!key) {
      throw new Error("No encryption key available");
    }

    const iv = randomBytes(ENCRYPTION_CONFIG.ivLength);
    const salt = randomBytes(ENCRYPTION_CONFIG.saltLength);

    const cipher = createCipheriv(ENCRYPTION_CONFIG.algorithm, key, iv) as CipherGCM;

    const plaintextBuffer = Buffer.isBuffer(plaintext) 
      ? plaintext 
      : Buffer.from(plaintext, "utf8");

    const ciphertext = Buffer.concat([
      cipher.update(plaintextBuffer),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      ciphertext,
      iv,
      authTag,
      salt,
      version: ENCRYPTION_CONFIG.currentVersion,
    };
  }

  /**
   * Decrypt data
   */
  decrypt(encryptedData: EncryptedData, keyId?: string): Buffer {
    const key = keyId 
      ? this.keyManager.getKey(keyId)?.key 
      : this.keyManager.getCurrentKey()?.key;

    if (!key) {
      throw new Error("Decryption key not found");
    }

    const decipher = createDecipheriv(
      ENCRYPTION_CONFIG.algorithm,
      key,
      encryptedData.iv
    ) as DecipherGCM;

    decipher.setAuthTag(encryptedData.authTag);

    try {
      return Buffer.concat([
        decipher.update(encryptedData.ciphertext),
        decipher.final(),
      ]);
    } catch (error) {
      this.logger.error("Decryption failed - possible tampering", { error });
      throw new Error("Decryption failed - data may have been tampered with");
    }
  }

  /**
   * Encrypt to storable format (base64 strings)
   */
  encryptToString(plaintext: string, keyId?: string): EncryptedString {
    const encrypted = this.encrypt(plaintext, keyId);

    return {
      data: encrypted.ciphertext.toString("base64"),
      iv: encrypted.iv.toString("base64"),
      authTag: encrypted.authTag.toString("base64"),
      salt: encrypted.salt.toString("base64"),
      version: encrypted.version,
    };
  }

  /**
   * Decrypt from storable format
   */
  decryptFromString(encrypted: EncryptedString, keyId?: string): string {
    const encryptedData: EncryptedData = {
      ciphertext: Buffer.from(encrypted.data, "base64"),
      iv: Buffer.from(encrypted.iv, "base64"),
      authTag: Buffer.from(encrypted.authTag, "base64"),
      salt: Buffer.from(encrypted.salt, "base64"),
      version: encrypted.version,
    };

    return this.decrypt(encryptedData, keyId).toString("utf8");
  }

  /**
   * Encrypt object properties
   */
  encryptObject<T extends Record<string, unknown>>(
    obj: T,
    fieldsToEncrypt: (keyof T)[]
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...obj };

    for (const field of fieldsToEncrypt) {
      const value = obj[field];
      if (typeof value === "string") {
        result[field as string] = this.encryptToString(value);
      }
    }

    return result;
  }

  /**
   * Decrypt object properties
   */
  decryptObject<T extends Record<string, unknown>>(
    obj: T,
    encryptedFields: (keyof T)[]
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...obj };

    for (const field of encryptedFields) {
      const value = obj[field];
      if (this.isEncryptedString(value)) {
        result[field as string] = this.decryptFromString(value as EncryptedString);
      }
    }

    return result;
  }

  private isEncryptedString(value: unknown): value is EncryptedString {
    return (
      typeof value === "object" &&
      value !== null &&
      "data" in value &&
      "iv" in value &&
      "authTag" in value &&
      "version" in value
    );
  }
}

// =============================================================================
// DATA MASKING
// =============================================================================

export class DataMasking {
  /**
   * Mask sensitive data
   */
  static mask(value: string, options: MaskingOptions): string {
    const maskChar = options.maskChar || "*";

    switch (options.type) {
      case "full":
        return maskChar.repeat(value.length);

      case "partial":
        return this.maskPartial(value, options.showFirst || 0, options.showLast || 0, maskChar);

      case "email":
        return this.maskEmail(value);

      case "credit_card":
        return this.maskCreditCard(value);

      case "ssn":
        return this.maskSSN(value);

      case "phone":
        return this.maskPhone(value);

      default:
        return maskChar.repeat(value.length);
    }
  }

  private static maskPartial(value: string, showFirst: number, showLast: number, maskChar: string): string {
    if (value.length <= showFirst + showLast) {
      return maskChar.repeat(value.length);
    }

    const first = value.slice(0, showFirst);
    const last = value.slice(-showLast);
    const masked = maskChar.repeat(value.length - showFirst - showLast);

    return `${first}${masked}${last}`;
  }

  private static maskEmail(email: string): string {
    const parts = email.split("@");
    const local = parts[0];
    const domain = parts[1];
    if (!local || !domain) return "*".repeat(email.length);

    const maskedLocal = local.length > 2 
      ? `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}`
      : "*".repeat(local.length);

    return `${maskedLocal}@${domain}`;
  }

  private static maskCreditCard(card: string): string {
    const cleaned = card.replace(/\s/g, "");
    if (cleaned.length < 4) return "*".repeat(card.length);
    return `${"*".repeat(cleaned.length - 4)}${cleaned.slice(-4)}`;
  }

  private static maskSSN(ssn: string): string {
    const cleaned = ssn.replace(/-/g, "");
    if (cleaned.length !== 9) return "*".repeat(ssn.length);
    return `***-**-${cleaned.slice(-4)}`;
  }

  private static maskPhone(phone: string): string {
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length < 4) return "*".repeat(phone.length);
    return `${"*".repeat(cleaned.length - 4)}${cleaned.slice(-4)}`;
  }
}

// =============================================================================
// TOKENIZATION SERVICE
// =============================================================================

export class TokenizationService {
  private readonly tokens = new Map<string, TokenMapping>();
  private readonly reverseMap = new Map<string, string>();
  private readonly logger = getLogger();

  /**
   * Tokenize sensitive data
   */
  tokenize(
    data: string,
    expiresInMs?: number
  ): string {
    // Check if already tokenized
    if (this.reverseMap.has(data)) {
      return this.reverseMap.get(data)!;
    }

    // Generate token
    const token = `tok_${randomBytes(16).toString("hex")}`;
    const now = Date.now();

    const mapping: TokenMapping = {
      token,
      original: data,
      createdAt: now,
      expiresAt: expiresInMs ? now + expiresInMs : undefined,
    };

    this.tokens.set(token, mapping);
    this.reverseMap.set(data, token);

    this.logger.debug("Data tokenized", { token });

    return token;
  }

  /**
   * Detokenize
   */
  detokenize(token: string): string | null {
    const mapping = this.tokens.get(token);
    
    if (!mapping) {
      return null;
    }

    // Check expiration
    if (mapping.expiresAt && Date.now() > mapping.expiresAt) {
      this.tokens.delete(token);
      this.reverseMap.delete(mapping.original);
      return null;
    }

    return mapping.original;
  }

  /**
   * Delete token
   */
  deleteToken(token: string): boolean {
    const mapping = this.tokens.get(token);
    if (mapping) {
      this.tokens.delete(token);
      this.reverseMap.delete(mapping.original);
      return true;
    }
    return false;
  }

  /**
   * Cleanup expired tokens
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [token, mapping] of Array.from(this.tokens.entries())) {
      if (mapping.expiresAt && now > mapping.expiresAt) {
        this.tokens.delete(token);
        this.reverseMap.delete(mapping.original);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info("Cleaned up expired tokens", { removed });
    }

    return removed;
  }

  /**
   * Get token count
   */
  getTokenCount(): number {
    return this.tokens.size;
  }
}

// =============================================================================
// ENVIRONMENT ENCRYPTION
// =============================================================================

/**
 * Encrypt environment variable values
 */
export function encryptEnvValue(value: string, encryptionKey?: string): string {
  const key = encryptionKey || process.env["ENCRYPTION_KEY"];
  if (!key) {
    throw new Error("Encryption key not available");
  }

  const keyManager = new KeyManager();
  const encryption = new EncryptionService(keyManager);
  
  return JSON.stringify(encryption.encryptToString(value));
}

/**
 * Decrypt environment variable value
 */
export function decryptEnvValue(encryptedValue: string, encryptionKey?: string): string {
  const key = encryptionKey || process.env["ENCRYPTION_KEY"];
  if (!key) {
    throw new Error("Encryption key not available");
  }

  const keyManager = new KeyManager();
  const encryption = new EncryptionService(keyManager);
  
  return encryption.decryptFromString(JSON.parse(encryptedValue));
}

// =============================================================================
// EXPORTS
// =============================================================================

export const keyManager = new KeyManager(process.env["ENCRYPTION_KEY"]);
export const encryptionService = new EncryptionService(keyManager);
export const tokenizationService = new TokenizationService();
