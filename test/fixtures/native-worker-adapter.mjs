export async function run(request, context) {
  if (request.prompt === "hang") await new Promise(() => {});
  if (request.prompt === "overflow") return "x".repeat(300000);
  if (request.prompt === "malformed") process.stdout.write("not-json\n");
  if (request.prompt === "noisy") { process.stderr.write("x".repeat(1000)); await new Promise(() => {}); }
  if (request.prompt === "environment") return JSON.stringify({ secret: process.env.SANDORA_SECRET_TEST ?? null, tools: context.registry.list().map(tool => tool.name) });
  return `fixture:${request.prompt}`;
}
