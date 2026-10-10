const http = require("node:http");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const key = `timeout-${randomUUID()}`;
const body = JSON.stringify({
  destinatario: "Cliente prueba timeout",
  direccion: "Direccion prueba timeout",
});

async function sql(query) {
  const { stdout } = await execute("docker", [
    "compose", "exec", "-T", "db",
    "psql", "-U", "rutaexpress", "-d", "rutaexpress",
    "-t", "-A", "-c", query,
  ]);

  return JSON.parse(stdout.trim());
}

function request(delay, timeoutMs) {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const start = new Date().toISOString();
    const clock = performance.now();
    let completed = false;

    const finish = (data) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);

      resolve({
        request_id: requestId,
        inicio: start,
        fin: new Date().toISOString(),
        duracion_ms: Math.round(performance.now() - clock),
        ...data,
      });
    };

    const req = http.request({
      hostname: "localhost",
      port: 8080,
      path: "/envios",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Idempotency-Key": key,
        "X-Request-ID": requestId,
        ...(delay ? { "X-Test-Delay": "true" } : {}),
      },
    }, (res) => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { content += chunk; });
      res.on("end", () => finish({
        resultado_cliente: "respuesta",
        http: res.statusCode,
        instancia: res.headers["x-instance-id"] || null,
        cuerpo: content,
      }));
      res.on("error", (error) => finish({
        resultado_cliente: "error",
        http: null,
        error: error.code || error.message,
      }));
    });

    const timer = setTimeout(() => {
      finish({
        resultado_cliente: "timeout",
        http: null,
        error: "CLIENT_TIMEOUT_2000MS",
      });
      req.destroy();
    }, timeoutMs);

    req.on("error", (error) => finish({
      resultado_cliente: "error",
      http: null,
      error: error.code || error.message,
    }));

    req.end(body);
  });
}

async function main() {
  fs.mkdirSync("evidencias", { recursive: true });

  console.log("Clave de operacion:", key);

  const pending = request(true, 2000);

  // Consultar mientras el cliente todavía espera la respuesta.
  await sleep(500);

  const observation = await sql(`
    SELECT json_build_object(
      'observado_en', clock_timestamp(),
      'cantidad', (SELECT count(*) FROM envios
                   WHERE clave_operacion = '${key}'),
      'intentos', (SELECT json_agg(i) FROM (
        SELECT request_id, instancia, resultado, envio_id, procesado_en
        FROM intentos WHERE clave_operacion = '${key}'
      ) i)
    );
  `);

  const first = await pending;

  await sleep(600);

  // Misma operación, sin solicitar la demora.
  const retry = await request(false, 10000);

  await sleep(300);

  const finalState = await sql(`
    SELECT json_build_object(
      'cantidad_envios', (SELECT count(*) FROM envios
                         WHERE clave_operacion = '${key}'),
      'intentos', (SELECT json_agg(i) FROM (
        SELECT request_id, instancia, resultado, envio_id,
               iniciado_en, procesado_en,
               codigo_http_previsto, codigo_http_emitido,
               conexion_cerrada_antes_de_responder
        FROM intentos
        WHERE clave_operacion = '${key}'
        ORDER BY id
      ) i)
    );
  `);

  const evidence = {
    clave_operacion: key,
    observacion_durante_espera: observation,
    primer_intento_cliente: first,
    reintento_cliente: retry,
    estado_final: finalState,
  };

  fs.writeFileSync(
    "evidencias/09-timeout.json",
    JSON.stringify(evidence, null, 2)
  );

  console.table([first, retry].map((attempt) => ({
    Cliente: attempt.resultado_cliente,
    HTTP: attempt.http,
    Milisegundos: attempt.duracion_ms,
    Instancia: attempt.instancia || "-",
  })));

  console.log("Observacion durante la espera:");
  console.log(JSON.stringify(observation, null, 2));
  console.log("Estado final en PostgreSQL:");
  console.log(JSON.stringify(finalState, null, 2));
  console.log("Evidencia guardada: evidencias/09-timeout.json");
}

main().catch((error) => {
  console.error("La prueba no termino:", error.message);
  process.exitCode = 1;
});