import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { makeHandler } from "./handler.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(makeHandler({
  env: (name: string) => Deno.env.get(name),
  fetch: (input: string, init: RequestInit) => fetch(input, init),
  verify: async (token: string) => {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user?.id || null;
  },
  reserve: async (id: string, image: boolean) => {
    const { data, error } = await admin.rpc("reserve_ai_request", { p_user_id: id, p_image: image });
    if (error) throw new Error("quota unavailable");
    return data;
  },
}));
