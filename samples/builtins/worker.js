import secrets from "demo:secrets"

export default {
  async fetch(req, env) {
    return new Response(secrets.caveKey);
  }
};
