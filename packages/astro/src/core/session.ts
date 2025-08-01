import { stringify as rawStringify, unflatten as rawUnflatten } from 'devalue';

import {
	type BuiltinDriverName,
	type BuiltinDriverOptions,
	builtinDrivers,
	createStorage,
	type Driver,
	type Storage,
} from 'unstorage';
import type {
	ResolvedSessionConfig,
	RuntimeMode,
	SessionConfig,
	SessionDriverName,
} from '../types/public/config.js';
import type { AstroCookieSetOptions, AstroCookies } from './cookies/cookies.js';
import { SessionStorageInitError, SessionStorageSaveError } from './errors/errors-data.js';
import { AstroError } from './errors/index.js';

export const PERSIST_SYMBOL = Symbol();

const DEFAULT_COOKIE_NAME = 'astro-session';
const VALID_COOKIE_REGEX = /^[\w-]+$/;

interface SessionEntry {
	data: any;
	expires?: number;
}

const unflatten: typeof rawUnflatten = (parsed, _) => {
	// Revive URL objects
	return rawUnflatten(parsed, {
		URL: (href) => new URL(href),
	});
};

const stringify: typeof rawStringify = (data, _) => {
	return rawStringify(data, {
		// Support URL objects
		URL: (val) => val instanceof URL && val.href,
	});
};

export class AstroSession<TDriver extends SessionDriverName = any> {
	// The cookies object.
	#cookies: AstroCookies;
	// The session configuration.
	#config: Omit<ResolvedSessionConfig<TDriver>, 'cookie'> & {
		driver: NonNullable<ResolvedSessionConfig<TDriver>['driver']>;
	};
	// The cookie config
	#cookieConfig?: AstroCookieSetOptions;
	// The cookie name
	#cookieName: string;
	// The unstorage object for the session driver.
	#storage: Storage | undefined;
	#data: Map<string, SessionEntry> | undefined;
	// The session ID. A v4 UUID.
	#sessionID: string | undefined;
	// Sessions to destroy. Needed because we won't have the old session ID after it's destroyed locally.
	#toDestroy = new Set<string>();
	// Session keys to delete. Used for partial data sets to avoid overwriting the deleted value.
	#toDelete = new Set<string>();
	// Whether the session is dirty and needs to be saved.
	#dirty = false;
	// Whether the session cookie has been set.
	#cookieSet = false;
	// The local data is "partial" if it has not been loaded from storage yet and only
	// contains values that have been set or deleted in-memory locally.
	// We do this to avoid the need to block on loading data when it is only being set.
	// When we load the data from storage, we need to merge it with the local partial data,
	// preserving in-memory changes and deletions.
	#partial = true;

	static #sharedStorage = new Map<string, Storage>();

	constructor(
		cookies: AstroCookies,
		{
			cookie: cookieConfig = DEFAULT_COOKIE_NAME,
			...config
		}: NonNullable<ResolvedSessionConfig<TDriver>>,
		runtimeMode?: RuntimeMode,
	) {
		const { driver } = config;
		if (!driver) {
			throw new AstroError({
				...SessionStorageInitError,
				message: SessionStorageInitError.message(
					'No driver was defined in the session configuration and the adapter did not provide a default driver.',
				),
			});
		}
		this.#cookies = cookies;
		let cookieConfigObject: AstroCookieSetOptions | undefined;
		if (typeof cookieConfig === 'object') {
			const { name = DEFAULT_COOKIE_NAME, ...rest } = cookieConfig;
			this.#cookieName = name;
			cookieConfigObject = rest;
		} else {
			this.#cookieName = cookieConfig || DEFAULT_COOKIE_NAME;
		}
		this.#cookieConfig = {
			sameSite: 'lax',
			secure: runtimeMode === 'production',
			path: '/',
			...cookieConfigObject,
			httpOnly: true,
		};
		this.#config = { ...config, driver };
	}

	/**
	 * Gets a session value. Returns `undefined` if the session or value does not exist.
	 */
	async get<T = void, K extends string = keyof App.SessionData | (string & {})>(
		key: K,
	): Promise<
		(T extends void ? (K extends keyof App.SessionData ? App.SessionData[K] : any) : T) | undefined
	> {
		return (await this.#ensureData()).get(key)?.data;
	}

	/**
	 * Checks if a session value exists.
	 */
	async has(key: string): Promise<boolean> {
		return (await this.#ensureData()).has(key);
	}

	/**
	 * Gets all session values.
	 */
	async keys() {
		return (await this.#ensureData()).keys();
	}

	/**
	 * Gets all session values.
	 */
	async values() {
		return [...(await this.#ensureData()).values()].map((entry) => entry.data);
	}

	/**
	 * Gets all session entries.
	 */
	async entries() {
		return [...(await this.#ensureData()).entries()].map(([key, entry]) => [key, entry.data]);
	}

	/**
	 * Deletes a session value.
	 */
	delete(key: string) {
		this.#data?.delete(key);
		if (this.#partial) {
			this.#toDelete.add(key);
		}
		this.#dirty = true;
	}

	/**
	 * Sets a session value. The session is created if it does not exist.
	 */

	set<T = void, K extends string = keyof App.SessionData | (string & {})>(
		key: K,
		value: T extends void
			? K extends keyof App.SessionData
				? App.SessionData[K]
				: any
			: NoInfer<T>,
		{ ttl }: { ttl?: number } = {},
	) {
		if (!key) {
			throw new AstroError({
				...SessionStorageSaveError,
				message: 'The session key was not provided.',
			});
		}
		// save a clone of the passed in object so later updates are not
		// persisted into the store. Attempting to serialize also allows
		// us to throw an error early if needed.
		let cloned: T;
		try {
			cloned = unflatten(JSON.parse(stringify(value)));
		} catch (err) {
			throw new AstroError(
				{
					...SessionStorageSaveError,
					message: `The session data for ${key} could not be serialized.`,
					hint: 'See the devalue library for all supported types: https://github.com/rich-harris/devalue',
				},
				{ cause: err },
			);
		}
		if (!this.#cookieSet) {
			this.#setCookie();
			this.#cookieSet = true;
		}
		this.#data ??= new Map();
		const lifetime = ttl ?? this.#config.ttl;
		// If ttl is numeric, it is the number of seconds until expiry. To get an expiry timestamp, we convert to milliseconds and add to the current time.
		const expires = typeof lifetime === 'number' ? Date.now() + lifetime * 1000 : lifetime;
		this.#data.set(key, {
			data: cloned,
			expires,
		});
		this.#dirty = true;
	}

	/**
	 * Destroys the session, clearing the cookie and storage if it exists.
	 */
	destroy() {
		// We don't use #ensureSessionID here because we don't want to create a new session ID if it doesn't exist.
		const sessionId = this.#sessionID ?? this.#cookies.get(this.#cookieName)?.value;
		if (sessionId) {
			this.#toDestroy.add(sessionId);
		}
		this.#cookies.delete(this.#cookieName, this.#cookieConfig);
		this.#sessionID = undefined;
		this.#data = undefined;
		this.#dirty = true;
	}

	/**
	 * Regenerates the session, creating a new session ID. The existing session data is preserved.
	 */

	async regenerate() {
		let data = new Map();
		try {
			data = await this.#ensureData();
		} catch (err) {
			// Log the error but continue with empty data
			console.error('Failed to load session data during regeneration:', err);
		}

		// Store the old session ID for cleanup
		const oldSessionId = this.#sessionID;

		// Create new session
		this.#sessionID = crypto.randomUUID();
		this.#data = data;
		await this.#setCookie();

		// Clean up old session asynchronously
		if (oldSessionId && this.#storage) {
			this.#storage.removeItem(oldSessionId).catch((err) => {
				console.error('Failed to remove old session data:', err);
			});
		}
	}

	// Persists the session data to storage.
	// This is called automatically at the end of the request.
	// Uses a symbol to prevent users from calling it directly.
	async [PERSIST_SYMBOL]() {
		// Handle session data persistence

		if (!this.#dirty && !this.#toDestroy.size) {
			return;
		}

		const storage = await this.#ensureStorage();

		if (this.#dirty && this.#data) {
			const data = await this.#ensureData();
			this.#toDelete.forEach((key) => data.delete(key));
			const key = this.#ensureSessionID();
			let serialized;
			try {
				serialized = stringify(data);
			} catch (err) {
				throw new AstroError(
					{
						...SessionStorageSaveError,
						message: SessionStorageSaveError.message(
							'The session data could not be serialized.',
							this.#config.driver,
						),
					},
					{ cause: err },
				);
			}
			await storage.setItem(key, serialized);
			this.#dirty = false;
		}

		// Handle destroyed session cleanup
		if (this.#toDestroy.size > 0) {
			const cleanupPromises = [...this.#toDestroy].map((sessionId) =>
				storage.removeItem(sessionId).catch((err) => {
					console.error(`Failed to clean up session ${sessionId}:`, err);
				}),
			);
			await Promise.all(cleanupPromises);
			this.#toDestroy.clear();
		}
	}

	get sessionID() {
		return this.#sessionID;
	}

	/**
	 * Loads a session from storage with the given ID, and replaces the current session.
	 * Any changes made to the current session will be lost.
	 * This is not normally needed, as the session is automatically loaded using the cookie.
	 * However it can be used to restore a session where the ID has been recorded somewhere
	 * else (e.g. in a database).
	 */
	async load(sessionID: string) {
		this.#sessionID = sessionID;
		this.#data = undefined;
		await this.#setCookie();
		await this.#ensureData();
	}

	/**
	 * Sets the session cookie.
	 */
	async #setCookie() {
		if (!VALID_COOKIE_REGEX.test(this.#cookieName)) {
			throw new AstroError({
				...SessionStorageSaveError,
				message: 'Invalid cookie name. Cookie names can only contain letters, numbers, and dashes.',
			});
		}

		const value = this.#ensureSessionID();
		this.#cookies.set(this.#cookieName, value, this.#cookieConfig);
	}

	/**
	 * Attempts to load the session data from storage, or creates a new data object if none exists.
	 * If there is existing partial data, it will be merged into the new data object.
	 */

	async #ensureData() {
		const storage = await this.#ensureStorage();
		if (this.#data && !this.#partial) {
			return this.#data;
		}
		this.#data ??= new Map();

		// We stored this as a devalue string, but unstorage will have parsed it as JSON
		const raw = await storage.get<any[]>(this.#ensureSessionID());
		if (!raw) {
			// If there is no existing data in storage we don't need to merge anything
			// and can just return the existing local data.
			return this.#data;
		}

		try {
			const storedMap = unflatten(raw);
			if (!(storedMap instanceof Map)) {
				await this.destroy();
				throw new AstroError({
					...SessionStorageInitError,
					message: SessionStorageInitError.message(
						'The session data was an invalid type.',
						this.#config.driver,
					),
				});
			}

			const now = Date.now();

			// Only copy values from storage that:
			// 1. Don't exist in memory (preserving in-memory changes)
			// 2. Haven't been marked for deletion
			// 3. Haven't expired
			for (const [key, value] of storedMap) {
				const expired = typeof value.expires === 'number' && value.expires < now;
				if (!this.#data.has(key) && !this.#toDelete.has(key) && !expired) {
					this.#data.set(key, value);
				}
			}

			this.#partial = false;
			return this.#data;
		} catch (err) {
			await this.destroy();
			if (err instanceof AstroError) {
				throw err;
			}
			throw new AstroError(
				{
					...SessionStorageInitError,
					message: SessionStorageInitError.message(
						'The session data could not be parsed.',
						this.#config.driver,
					),
				},
				{ cause: err },
			);
		}
	}

	/**
	 * Returns the session ID, generating a new one if it does not exist.
	 */
	#ensureSessionID() {
		this.#sessionID ??= this.#cookies.get(this.#cookieName)?.value ?? crypto.randomUUID();
		return this.#sessionID;
	}

	/**
	 * Ensures the storage is initialized.
	 * This is called automatically when a storage operation is needed.
	 */
	async #ensureStorage(): Promise<Storage> {
		if (this.#storage) {
			return this.#storage;
		}

		// We reuse the storage object if it has already been created.
		// We don't need to worry about the config changing because editing it
		// will always restart the process.
		if (AstroSession.#sharedStorage.has(this.#config.driver)) {
			this.#storage = AstroSession.#sharedStorage.get(this.#config.driver);
			return this.#storage!;
		}

		if (this.#config.driver === 'test') {
			this.#storage = (this.#config as SessionConfig<'test'>).options.mockStorage;
			return this.#storage!;
		}
		// Use fs-lite rather than fs, because fs can't be bundled. Add a default base path if not provided.
		if (
			this.#config.driver === 'fs' ||
			this.#config.driver === 'fsLite' ||
			this.#config.driver === 'fs-lite'
		) {
			this.#config.options ??= {};
			this.#config.driver = 'fs-lite';
			(this.#config.options as BuiltinDriverOptions['fs-lite']).base ??= '.astro/session';
		}

		let driver: ((config: SessionConfig<TDriver>['options']) => Driver) | null = null;

		try {
			if (this.#config.driverModule) {
				driver = (await this.#config.driverModule()).default;
			} else if (this.#config.driver) {
				const driverName = resolveSessionDriverName(this.#config.driver);
				if (driverName) {
					driver = (await import(driverName)).default;
				}
			}
		} catch (err: any) {
			// If the driver failed to load, throw an error.
			if (err.code === 'ERR_MODULE_NOT_FOUND') {
				throw new AstroError(
					{
						...SessionStorageInitError,
						message: SessionStorageInitError.message(
							err.message.includes(`Cannot find package`)
								? 'The driver module could not be found.'
								: err.message,
							this.#config.driver,
						),
					},
					{ cause: err },
				);
			}
			throw err;
		}

		if (!driver) {
			throw new AstroError({
				...SessionStorageInitError,
				message: SessionStorageInitError.message(
					'The module did not export a driver.',
					this.#config.driver,
				),
			});
		}

		try {
			this.#storage = createStorage({
				driver: driver(this.#config.options),
			});
			AstroSession.#sharedStorage.set(this.#config.driver, this.#storage);
			return this.#storage;
		} catch (err) {
			throw new AstroError(
				{
					...SessionStorageInitError,
					message: SessionStorageInitError.message('Unknown error', this.#config.driver),
				},
				{ cause: err },
			);
		}
	}
}

function resolveSessionDriverName(driver: string | undefined): string | null {
	if (!driver) {
		return null;
	}
	try {
		if (driver === 'fs') {
			return builtinDrivers.fsLite;
		}
		if (driver in builtinDrivers) {
			return builtinDrivers[driver as BuiltinDriverName];
		}
	} catch {
		return null;
	}

	return driver;
}
