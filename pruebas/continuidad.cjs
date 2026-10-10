const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const records = [];
const commands = [];

async function docker(args) {
  const start = new Date().toISOString();
  const { stdout, stderr } = await execute("docker", ["compose", ...args]);

  commands.push({
    comando: ["docker", "compose", ...args].join(" "),
    inicio: start,
    fin: new Date().toISOString(),
    salida: stdout + stderr,
  });
}

async function health(phase, number) {
  const record = {
    fase: phase,
    consulta: number,
    request_id: randomUUID(),
    inicio: new Date().toISOString(),
  };

  try {
    const response = await fetch("http://localhost:8080/health", {
      headers: { "X-Request-ID": record.request_id },
      signal: AbortSignal.timeout(5000),
    });

    record.http = response.status;
    record.instancia = response.headers.get("x-instance-id");
    record.respuesta = await response.text();
  } catch (error) {
    record.http = null;
    record.instancia = null;
    record.error = error.name + ": " + error.message;
  }

  record.fin = new Date().toISOString();
  records.push(record);

  fs.appendFileSync(
    "evidencias/11-continuidad.jsonl",
    JSON.stringify(record) + "\n"
  );
}

async function sample(phase, count) {
  for (let number = 1; number <= count; number++) {
    await health(phase, number);
    await sleep(600);
  }
}

async function main() {
  fs.mkdirSync("evidencias", { recursive: true });
  fs.writeFileSync("evidencias/11-continuidad.jsonl", "");

  await sample("Antes", 3);

  try {
    // Consultar también durante la transición de apagado.
    await Promise.all([
      docker(["stop", "-t", "1", "app2"]),
      sample("Transicion", 6),
    ]);

    await docker(["ps", "-a"]);
    await sample("App2 detenida", 9);
  } finally {
    // Recuperar app2 aunque ocurra un error durante la prueba.
    await docker(["start", "app2"]);
  }

  await sleep(3000);
  await sample("App2 recuperada", 9);
  await docker(["ps", "-a"]);

  fs.writeFileSync(
    "evidencias/11-continuidad.json",
    JSON.stringify({ comandos: commands, solicitudes: records }, null, 2)
  );

  console.table(records.map((record) => ({
    Fase: record.fase,
    Consulta: record.consulta,
    HTTP: record.http,
    Instancia: record.instancia || "-",
    Error: record.error || "",
  })));

  console.log("Evidencias guardadas en 11-continuidad.json y .jsonl");
}

main().catch((error) => {
  console.error("La prueba no termino:", error.message);
  process.exitCode = 1;
});