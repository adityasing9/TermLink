import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform, type PeerPublicIdentity, type PlatformKind } from '../../core/src/index';
import type { EncryptedEnvelope } from '../../protocol/src/index';

export interface LocalIdentity {
  publicIdentity: PeerPublicIdentity;
  signingPrivateKey: string; // base64url PKCS8 Ed25519 — NEVER transmitted
  dhPrivateKey: string; // base64url PKCS8 X25519 — NEVER transmitted
  createdAt: number;
}

export interface TrustedDeviceRecord {
  deviceId: string;
  deviceName: string;
  platform: PlatformKind;
  fingerprint: string;
  signingPublicKey: string;
  status: 'trusted' | 'revoked';
  updatedAt: number;
}

export function computeFingerprint(signingPublicKeyBase64Url: string): string {
  const hash = crypto.createHash('sha256').update(signingPublicKeyBase64Url, 'utf8').digest('hex').toUpperCase();
  // 16 bytes -> 32 hex chars grouped in pairs (e.g. A2:9F:81:7B:...)
  const shortHex = hash.slice(0, 32);
  return shortHex.match(/.{2}/g)?.join(':') ?? shortHex;
}

export function generateLocalIdentity(deviceName?: string): LocalIdentity {
  const ed = crypto.generateKeyPairSync('ed25519');
  const x25519 = crypto.generateKeyPairSync('x25519');

  const signingPublicKey = ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const signingPrivateKey = ed.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');

  const dhPublicKey = x25519.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const dhPrivateKey = x25519.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');

  const fingerprint = computeFingerprint(signingPublicKey);
  const deviceId = crypto.randomBytes(12).toString('hex');
  const name = (deviceName || os.hostname() || 'TERMLINK-HOST').slice(0, 64);

  return {
    publicIdentity: {
      deviceId,
      deviceName: name,
      platform: detectPlatform(),
      osDetail: `${os.type()} ${os.release()}`,
      signingPublicKey,
      dhPublicKey,
      fingerprint,
    },
    signingPrivateKey,
    dhPrivateKey,
    createdAt: Date.now(),
  };
}

export function deriveSharedSecret(localDhPrivateKey: string, remoteDhPublicKey: string): Buffer {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(localDhPrivateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKey = crypto.createPublicKey({
    key: Buffer.from(remoteDhPublicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const shared = crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
  // HKDF-SHA256 derivation for AES-256-GCM key
  return Buffer.from(
    crypto.hkdfSync('sha256', shared, Buffer.from('termlink-e2ee-v1'), Buffer.from('session-key'), 32)
  );
}

export function signBytes(localSigningPrivateKey: string, data: Buffer): string {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(localSigningPrivateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, data, privKey).toString('base64url');
}

export function verifySignature(remoteSigningPublicKey: string, data: Buffer, signatureBase64Url: string): boolean {
  try {
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(remoteSigningPublicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, data, pubKey, Buffer.from(signatureBase64Url, 'base64url'));
  } catch {
    return false;
  }
}

export function encryptForPeer(
  localIdentity: LocalIdentity,
  senderPeerId: string,
  recipientPeerId: string,
  remoteDhPublicKey: string,
  plaintextObject: unknown
): EncryptedEnvelope {
  const key = deriveSharedSecret(localIdentity.dhPrivateKey, remoteDhPublicKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObject), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const ivB64 = iv.toString('base64url');
  const ctB64 = encrypted.toString('base64url');
  const tagB64 = authTag.toString('base64url');
  const sigInput = Buffer.from(`${senderPeerId}|${recipientPeerId}|${ivB64}|${ctB64}|${tagB64}`, 'utf8');
  const signature = signBytes(localIdentity.signingPrivateKey, sigInput);

  return {
    senderPeerId,
    recipientPeerId,
    iv: ivB64,
    ciphertext: ctB64,
    authTag: tagB64,
    signature,
    timestamp: Date.now(),
    e2ee: true,
  };
}

export function decryptFromPeer<T = unknown>(
  localIdentity: LocalIdentity,
  remotePublicIdentity: PeerPublicIdentity,
  envelope: EncryptedEnvelope
): T {
  const sigInput = Buffer.from(
    `${envelope.senderPeerId}|${envelope.recipientPeerId}|${envelope.iv}|${envelope.ciphertext}|${envelope.authTag}`,
    'utf8'
  );
  const sigOk = verifySignature(remotePublicIdentity.signingPublicKey, sigInput, envelope.signature);
  if (!sigOk) {
    throw new Error('Cryptographic signature verification failed — possible peer spoofing or tampered message.');
  }

  const key = deriveSharedSecret(localIdentity.dhPrivateKey, remotePublicIdentity.dhPublicKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

export function getDefaultStorageDir(): string {
  if (process.env.TERMLINK_STORAGE_DIR) {
    return process.env.TERMLINK_STORAGE_DIR;
  }
  const home = os.homedir();
  return path.join(home, '.termlink');
}

export class IdentityStore {
  private readonly dir: string;
  private readonly identityPath: string;
  private readonly trustPath: string;

  constructor(baseDir: string = getDefaultStorageDir()) {
    this.dir = baseDir;
    this.identityPath = path.join(this.dir, 'identity.secret.json');
    this.trustPath = path.join(this.dir, 'trusted-devices.json');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  loadOrCreate(deviceName?: string): LocalIdentity {
    this.ensureDir();
    if (fs.existsSync(this.identityPath)) {
      const raw = JSON.parse(fs.readFileSync(this.identityPath, 'utf8')) as LocalIdentity;
      if (deviceName && raw.publicIdentity.deviceName !== deviceName) {
        raw.publicIdentity.deviceName = deviceName;
        this.save(raw);
      }
      return raw;
    }
    const created = generateLocalIdentity(deviceName);
    this.save(created);
    return created;
  }

  save(identity: LocalIdentity): void {
    this.ensureDir();
    fs.writeFileSync(this.identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 });
  }

  renameDevice(newName: string): LocalIdentity {
    const id = this.loadOrCreate();
    id.publicIdentity.deviceName = newName.trim().slice(0, 64);
    this.save(id);
    return id;
  }

  resetIdentity(deviceName?: string): LocalIdentity {
    const fresh = generateLocalIdentity(deviceName);
    this.save(fresh);
    return fresh;
  }

  exportPublicIdentity(): PeerPublicIdentity {
    return this.loadOrCreate().publicIdentity;
  }

  listDevices(): TrustedDeviceRecord[] {
    if (!fs.existsSync(this.trustPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.trustPath, 'utf8')) as TrustedDeviceRecord[];
    } catch {
      return [];
    }
  }

  private saveDevices(devices: TrustedDeviceRecord[]): void {
    this.ensureDir();
    fs.writeFileSync(this.trustPath, JSON.stringify(devices, null, 2), { mode: 0o600 });
  }

  trustDevice(identity: PeerPublicIdentity): TrustedDeviceRecord {
    const devices = this.listDevices().filter((d) => d.deviceId !== identity.deviceId);
    const rec: TrustedDeviceRecord = {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      platform: identity.platform,
      fingerprint: identity.fingerprint,
      signingPublicKey: identity.signingPublicKey,
      status: 'trusted',
      updatedAt: Date.now(),
    };
    devices.push(rec);
    this.saveDevices(devices);
    return rec;
  }

  revokeDevice(deviceIdOrFingerprint: string): boolean {
    const devices = this.listDevices();
    let changed = false;
    for (const d of devices) {
      if (d.deviceId === deviceIdOrFingerprint || d.fingerprint === deviceIdOrFingerprint) {
        d.status = 'revoked';
        d.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.saveDevices(devices);
    return changed;
  }

  isTrusted(identity: PeerPublicIdentity): boolean {
    const rec = this.listDevices().find((d) => d.deviceId === identity.deviceId);
    return Boolean(rec && rec.status === 'trusted' && rec.fingerprint === identity.fingerprint);
  }
}
