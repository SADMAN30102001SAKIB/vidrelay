"use client";

import {
  loginSchema,
  publicConfigSchema,
  registerSchema,
  userSchema
} from "@vidrelay/shared";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";

import type {
  LoginInput,
  PublicConfig,
  RegisterInput,
  User
} from "@vidrelay/shared";
import type { ReactNode } from "react";

import {
  ApiClientError,
  apiRequest,
  errorMessage,
  sessionExpiredEvent
} from "@/lib/api";

type SessionStatus = "anonymous" | "authenticated" | "error" | "loading";

interface SessionContextValue {
  config: PublicConfig | null;
  configError: string | null;
  login: (input: LoginInput) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  register: (input: RegisterInput) => Promise<User>;
  status: SessionStatus;
  user: User | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const readUser = (body: unknown): User => {
  const result = userSchema.safeParse(
    (body as { user?: unknown } | null)?.user
  );
  if (!result.success) {
    throw new Error("The service returned an invalid account response.");
  }
  return result.data;
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  const refreshConfig = useCallback(async () => {
    setConfigError(null);
    try {
      const body = await apiRequest<unknown>("/api/config");
      const parsed = publicConfigSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error("The service returned invalid capability information.");
      }
      setConfig(parsed.data);
    } catch (error) {
      setConfig(null);
      setConfigError(errorMessage(error));
      throw error;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const body = await apiRequest<unknown>("/api/auth/me");
      setUser(readUser(body));
      setStatus("authenticated");
    } catch (error) {
      setUser(null);
      if (error instanceof ApiClientError && error.status === 401) {
        setStatus("anonymous");
        return;
      }
      setStatus("error");
      throw error;
    }
  }, []);

  useEffect(() => {
    const expireSession = () => {
      setUser(null);
      setStatus("anonymous");
    };
    window.addEventListener(sessionExpiredEvent, expireSession);
    return () => window.removeEventListener(sessionExpiredEvent, expireSession);
  }, []);

  useEffect(() => {
    const load = async () => {
      const [, sessionResult] = await Promise.allSettled([
        refreshConfig(),
        refresh()
      ]);
      if (sessionResult.status === "rejected") {
        setStatus("error");
      }
    };
    void load();
  }, [refresh, refreshConfig]);

  const login = useCallback(async (input: LoginInput) => {
    const valid = loginSchema.parse(input);
    const body = await apiRequest<unknown>("/api/auth/login", {
      body: JSON.stringify(valid),
      method: "POST"
    });
    const nextUser = readUser(body);
    setUser(nextUser);
    setStatus("authenticated");
    return nextUser;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const valid = registerSchema.parse(input);
    const body = await apiRequest<unknown>("/api/auth/register", {
      body: JSON.stringify(valid),
      method: "POST"
    });
    const nextUser = readUser(body);
    setUser(nextUser);
    setStatus("authenticated");
    return nextUser;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiRequest<unknown>("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setStatus("anonymous");
      router.replace("/auth/login");
      router.refresh();
    }
  }, [router]);

  const value = useMemo<SessionContextValue>(
    () => ({
      config,
      configError,
      login,
      logout,
      refresh,
      refreshConfig,
      register,
      status,
      user
    }),
    [
      config,
      configError,
      login,
      logout,
      refresh,
      refreshConfig,
      register,
      status,
      user
    ]
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export const useSession = (): SessionContextValue => {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession must be used within SessionProvider.");
  }
  return value;
};
