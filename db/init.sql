BEGIN;

CREATE TABLE IF NOT EXISTS envios (
    id BIGSERIAL PRIMARY KEY,
    clave_operacion VARCHAR(128) NOT NULL UNIQUE,
    destinatario TEXT NOT NULL
        CHECK (length(trim(destinatario)) > 0),
    direccion TEXT NOT NULL
        CHECK (length(trim(direccion)) > 0),
    creado_en TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS intentos (
    id BIGSERIAL PRIMARY KEY,

    -- Identifica esta solicitud individual.
    request_id TEXT NOT NULL UNIQUE,

    -- Relaciona los reintentos de una misma operacion.
    clave_operacion TEXT,

    iniciado_en TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    procesado_en TIMESTAMPTZ(6),
    respuesta_finalizada_en TIMESTAMPTZ(6),

    metodo TEXT NOT NULL,
    ruta TEXT NOT NULL,
    instancia TEXT NOT NULL,

    resultado TEXT NOT NULL DEFAULT 'recibido'
        CHECK (resultado IN (
            'recibido',
            'creado',
            'repetido',
            'rechazado',
            'fallido'
        )),

    envio_id BIGINT REFERENCES envios(id),

    -- Codigo previsto por el backend.
    codigo_http_previsto INTEGER
        CHECK (codigo_http_previsto BETWEEN 100 AND 599),

    -- Se completa al finalizar la escritura de la respuesta.
    codigo_http_emitido INTEGER
        CHECK (codigo_http_emitido BETWEEN 100 AND 599),

    conexion_cerrada_antes_de_responder BOOLEAN NOT NULL DEFAULT FALSE,

    -- Solo codigo tecnico; no guardar cuerpos ni contrasenas.
    codigo_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_intentos_operacion
    ON intentos(clave_operacion);

CREATE INDEX IF NOT EXISTS idx_intentos_envio
    ON intentos(envio_id);

CREATE INDEX IF NOT EXISTS idx_intentos_fecha
    ON intentos(iniciado_en, id);

COMMIT;