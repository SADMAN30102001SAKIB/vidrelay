import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

interface CommandResult {
  stderr: string;
  stdout: string;
}

interface Scenario {
  configPath: string;
  migrationsPath: string;
  name: string;
  persistencePath: string;
  rootPath: string;
}

type QueryRow = Record<string, unknown>;

const isQueryRow = (value: unknown): value is QueryRow =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scriptPath = fileURLToPath(import.meta.url);
const backendPath = resolve(dirname(scriptPath), "..");
const sourceMigrationsPath = join(backendPath, "migrations");
const generatedStatePath = join(backendPath, ".wrangler");
const rehearsalPath = join(generatedStatePath, "migration-rehearsal");
const require = createRequire(import.meta.url);
const wranglerPackagePath = require.resolve("wrangler/package.json");
const wranglerPath = join(dirname(wranglerPackagePath), "bin", "wrangler.js");
const localEnvironment: NodeJS.ProcessEnv = { ...process.env };
for (const name of [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_EMAIL"
]) {
  delete localEnvironment[name];
}

const assertGeneratedPath = (targetPath: string): void => {
  const child = relative(generatedStatePath, resolve(targetPath));
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(
      `Refusing to modify an unsafe rehearsal path: ${targetPath}`
    );
  }
};

const commandText = (arguments_: readonly string[]): string =>
  ["wrangler", ...arguments_]
    .map(argument =>
      argument.includes(" ") ? JSON.stringify(argument) : argument
    )
    .join(" ");

const runLocalWrangler = (arguments_: readonly string[]): CommandResult => {
  if (!arguments_.includes("--local") || arguments_.includes("--remote")) {
    throw new Error(
      "Migration rehearsal commands must be explicitly local-only."
    );
  }

  process.stdout.write(`  ${commandText(arguments_)}\n`);
  const result = spawnSync(process.execPath, [wranglerPath, ...arguments_], {
    cwd: backendPath,
    encoding: "utf8",
    env: {
      ...localEnvironment,
      CI: "true",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false"
    },
    windowsHide: true
  });
  const { stderr, stdout } = result;

  if (result.error !== undefined) {
    throw new Error(
      `Failed to start ${commandText(arguments_)}: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `${commandText(arguments_)} exited with status ${String(result.status)}.`,
        stdout.trim(),
        stderr.trim()
      ]
        .filter(message => message.length > 0)
        .join("\n")
    );
  }

  return { stderr, stdout };
};

const localArguments = (
  scenario: Scenario,
  arguments_: readonly string[]
): string[] => [
  ...arguments_,
  "--local",
  "--persist-to",
  scenario.persistencePath,
  "--config",
  scenario.configPath
];

const createScenario = async (name: string): Promise<Scenario> => {
  const rootPath = join(rehearsalPath, name);
  const migrationsPath = join(rootPath, "migrations");
  const persistencePath = join(rootPath, "state");
  const configPath = join(rootPath, "wrangler.jsonc");
  await mkdir(migrationsPath, { recursive: true });
  await mkdir(persistencePath, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        compatibility_date: "2026-08-08",
        d1_databases: [
          {
            binding: "DB",
            database_name: `vidrelay-migration-rehearsal-${name}`,
            migrations_dir: "migrations"
          }
        ],
        main: "stub.mjs",
        name: `vidrelay-migration-rehearsal-${name}`
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(rootPath, "stub.mjs"),
    "export default { fetch: () => new Response(null, { status: 204 }) };\n",
    "utf8"
  );

  return { configPath, migrationsPath, name, persistencePath, rootPath };
};

const copyMigrations = async (
  scenario: Scenario,
  migrationNames: readonly string[]
): Promise<void> => {
  for (const migrationName of migrationNames) {
    await copyFile(
      join(sourceMigrationsPath, migrationName),
      join(scenario.migrationsPath, migrationName)
    );
  }
};

const applyMigrations = (scenario: Scenario): void => {
  runLocalWrangler(
    localArguments(scenario, ["d1", "migrations", "apply", "DB"])
  );
};

const executeFile = (scenario: Scenario, filePath: string): void => {
  runLocalWrangler(
    localArguments(scenario, [
      "d1",
      "execute",
      "DB",
      "--file",
      filePath,
      "--yes",
      "--json"
    ])
  );
};

const collectRows = (value: unknown, rows: QueryRow[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRows(item, rows);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  const queryResults: unknown = "results" in value ? value.results : undefined;
  if (Array.isArray(queryResults)) {
    for (const candidate of queryResults) {
      const row: unknown = candidate;
      if (isQueryRow(row)) {
        rows.push(row);
      }
    }
  }
};

const query = (scenario: Scenario, sql: string): QueryRow[] => {
  const result = runLocalWrangler(
    localArguments(scenario, [
      "d1",
      "execute",
      "DB",
      "--command",
      sql,
      "--yes",
      "--json"
    ])
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Wrangler returned invalid JSON for a local D1 query: ${result.stdout.trim()}`,
      { cause: error }
    );
  }

  const rows: QueryRow[] = [];
  collectRows(parsed, rows);
  return rows;
};

const expect = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const expectNumber = (
  row: QueryRow,
  property: string,
  expected: number,
  scenarioName: string
): void => {
  const actual = Number(row[property]);
  const received = String(row[property]);
  expect(
    actual === expected,
    `${scenarioName}: expected ${property}=${String(expected)}, received ${received}.`
  );
};

const verifySchema = (
  scenario: Scenario,
  migrationNames: readonly string[]
): void => {
  const applied = query(
    scenario,
    "SELECT name FROM d1_migrations ORDER BY id;"
  ).map(row => row.name);
  expect(
    JSON.stringify(applied) === JSON.stringify(migrationNames),
    `${scenario.name}: applied migration history did not match the repository. Received ${JSON.stringify(applied)}.`
  );

  const foreignKeyErrors = query(scenario, "PRAGMA foreign_key_check;");
  expect(
    foreignKeyErrors.length === 0,
    `${scenario.name}: foreign_key_check returned ${String(foreignKeyErrors.length)} error(s).`
  );

  const idempotencyColumn = query(scenario, "PRAGMA table_info(posts);").find(
    row => row.name === "idempotency_key"
  );
  expect(
    idempotencyColumn !== undefined,
    `${scenario.name}: posts.idempotency_key is missing.`
  );
  expectNumber(idempotencyColumn ?? {}, "notnull", 1, scenario.name);
  expect(
    idempotencyColumn?.dflt_value === "''",
    `${scenario.name}: posts.idempotency_key must finish with the empty-string application default.`
  );

  const idempotencyIndex = query(scenario, "PRAGMA index_list(posts);").find(
    row => row.name === "posts_workspace_idempotency_unique"
  );
  expect(
    idempotencyIndex !== undefined,
    `${scenario.name}: the post idempotency index is missing.`
  );
  expectNumber(idempotencyIndex ?? {}, "unique", 1, scenario.name);

  const temporaryTables = query(
    scenario,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND (name = '__new_posts' OR name LIKE '__posts_%_backup');"
  );
  expect(
    temporaryTables.length === 0,
    `${scenario.name}: temporary migration tables remain: ${JSON.stringify(temporaryTables)}.`
  );
};

const populatedFixture = `
PRAGMA foreign_keys = ON;

INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
VALUES ('user-fixture', 'fixture@example.invalid', 'Fixture User', 'fixture-hash', 'customer', 'active', 1000, 1000);

INSERT INTO workspaces (id, name, slug, timezone, status, created_at, updated_at)
VALUES ('workspace-fixture', 'Fixture Workspace', 'fixture-workspace', 'UTC', 'active', 1000, 1000);

INSERT INTO memberships (user_id, workspace_id, role, created_at)
VALUES ('user-fixture', 'workspace-fixture', 'owner', 1000);

INSERT INTO oauth_states (
  id, user_id, workspace_id, provider, return_to, code_verifier_encrypted,
  expires_at, consumed_at, created_at
)
VALUES (
  'oauth-fixture', 'user-fixture', 'workspace-fixture', 'youtube',
  '/app/connections', 'oauth-ciphertext', 999999, NULL, 1000
);

INSERT INTO deletion_requests (
  id, user_id, workspace_id, status, confirmation_reference_hash, last_error,
  requested_at, completed_at, updated_at
)
VALUES
  ('deletion-complete', 'user-fixture', 'workspace-fixture', 'complete', 'confirmation-complete', NULL, 800, 1000, 1200),
  ('deletion-failed', 'user-fixture', 'workspace-fixture', 'failed', 'confirmation-failed', 'old failure', 900, NULL, 1100);

INSERT INTO social_connections (
  id, workspace_id, connected_by_user_id, provider, remote_account_id,
  display_name, credentials_encrypted, key_version, scopes_json, metadata_json,
  status, created_at, updated_at
)
VALUES (
  'connection-fixture', 'workspace-fixture', 'user-fixture', 'youtube',
  'remote-fixture', 'Fixture Channel', 'fixture-ciphertext', 1, '[]', '{}',
  'connected', 1000, 1000
);

INSERT INTO uploads (
  id, workspace_id, created_by_user_id, r2_key, filename, mime_type,
  expected_size, actual_size, upload_mode, multipart_upload_id, part_size,
  status, validation_json, completed_at, created_at, updated_at
)
VALUES
  ('upload-one', 'workspace-fixture', 'user-fixture', 'fixtures/one.mp4', 'one.mp4', 'video/mp4', 1024, 1024, 'direct', 'multipart-one', 5242880, 'ready', '{"errors":[],"warnings":[]}', 1000, 1000, 1000),
  ('upload-two', 'workspace-fixture', 'user-fixture', 'fixtures/two.mp4', 'two.mp4', 'video/mp4', 2048, 2048, 'direct', 'multipart-two', 5242880, 'ready', '{"errors":[],"warnings":[]}', 1000, 1000, 1000);

INSERT INTO posts (
  id, workspace_id, created_by_user_id, upload_id, shared_caption, status,
  rights_confirmed_at, submitted_at, created_at, updated_at
)
VALUES
  ('post-one', 'workspace-fixture', 'user-fixture', 'upload-one', 'First fixture', 'published', 1000, 1000, 1000, 1000),
  ('post-two', 'workspace-fixture', 'user-fixture', 'upload-two', 'Second fixture', 'published', 1000, 1000, 1000, 1000);

INSERT INTO publish_destinations (
  id, post_id, connection_id, platform, settings_json, status, stage,
  attempt_number, workflow_instance_id, remote_session_id,
  remote_upload_url_encrypted, remote_post_id, remote_url, upload_offset,
  next_poll_at, last_error_code, last_error_message, outcome_unknown,
  published_at, created_at, updated_at
)
VALUES
  ('destination-one', 'post-one', 'connection-fixture', 'youtube', '{"fixture":1}', 'published', 'complete', 1, 'workflow-one', 'session-one', 'encrypted-upload-one', 'remote-post-one', 'https://example.invalid/one', 1024, 1100, 'destination-code-one', 'destination message one', 0, 1000, 1000, 1001),
  ('destination-two', 'post-two', 'connection-fixture', 'youtube', '{"fixture":2}', 'published', 'complete', 2, 'workflow-two', 'session-two', 'encrypted-upload-two', 'remote-post-two', 'https://example.invalid/two', 2048, 2100, 'destination-code-two', 'destination message two', 1, 2000, 2000, 2001);

INSERT INTO publish_attempts (
  id, destination_id, attempt_number, workflow_instance_id, status, stage,
  remote_session_id, remote_post_id, error_code, error_message, started_at,
  finished_at, updated_at
)
VALUES
  ('attempt-one', 'destination-one', 1, 'attempt-workflow-one', 'published', 'complete', 'session-one', 'remote-post-one', 'attempt-code-one', 'attempt message one', 900, 1000, 1001),
  ('attempt-two', 'destination-two', 2, 'attempt-workflow-two', 'published', 'complete', 'session-two', 'remote-post-two', 'attempt-code-two', 'attempt message two', 1900, 2000, 2001);

INSERT INTO media_leases (
  id, upload_id, destination_id, purpose, expires_at, revoked_at, created_at
)
VALUES
  ('lease-one', 'upload-one', 'destination-one', 'youtube', 999999, 900, 1000),
  ('lease-two', 'upload-two', 'destination-two', 'youtube', 1999999, 1900, 2000);
`;

const verifyPopulatedData = (scenario: Scenario): void => {
  const [counts] = query(
    scenario,
    `SELECT
      (SELECT COUNT(*) FROM posts) AS post_count,
      (SELECT COUNT(*) FROM publish_destinations) AS destination_count,
      (SELECT COUNT(*) FROM publish_attempts) AS attempt_count,
      (SELECT COUNT(*) FROM media_leases) AS lease_count,
      (SELECT COUNT(*) FROM oauth_states) AS oauth_state_count,
      (SELECT COUNT(*) FROM deletion_requests) AS deletion_count,
      (SELECT COUNT(*)
       FROM posts
       INNER JOIN publish_destinations ON publish_destinations.post_id = posts.id
       INNER JOIN publish_attempts ON publish_attempts.destination_id = publish_destinations.id
       INNER JOIN media_leases ON media_leases.destination_id = publish_destinations.id
       WHERE media_leases.upload_id = posts.upload_id) AS complete_relationship_count;`
  );
  expect(
    counts !== undefined,
    `${scenario.name}: fixture counts were not returned.`
  );
  expectNumber(counts ?? {}, "post_count", 2, scenario.name);
  expectNumber(counts ?? {}, "destination_count", 2, scenario.name);
  expectNumber(counts ?? {}, "attempt_count", 2, scenario.name);
  expectNumber(counts ?? {}, "lease_count", 2, scenario.name);
  expectNumber(counts ?? {}, "oauth_state_count", 0, scenario.name);
  expectNumber(counts ?? {}, "deletion_count", 2, scenario.name);
  expectNumber(counts ?? {}, "complete_relationship_count", 2, scenario.name);

  const posts = query(
    scenario,
    "SELECT id, idempotency_key FROM posts ORDER BY id;"
  );
  const expectedPosts = new Map([
    ["post-one", "legacy:post-one"],
    ["post-two", "legacy:post-two"]
  ]);
  expect(
    posts.length === expectedPosts.size &&
      posts.every(
        post =>
          typeof post.id === "string" &&
          typeof post.idempotency_key === "string" &&
          expectedPosts.get(post.id) === post.idempotency_key
      ),
    `${scenario.name}: legacy idempotency keys were not preserved uniquely: ${JSON.stringify(posts)}.`
  );

  const dependentRows = query(
    scenario,
    `SELECT
      posts.id AS post_id,
      posts.upload_id AS post_upload_id,
      publish_destinations.id AS destination_id,
      publish_destinations.connection_id AS connection_id,
      publish_destinations.platform AS platform,
      publish_destinations.settings_json AS settings_json,
      publish_destinations.status AS destination_status,
      publish_destinations.stage AS destination_stage,
      publish_destinations.attempt_number AS destination_attempt_number,
      publish_destinations.workflow_instance_id AS destination_workflow_instance_id,
      publish_destinations.remote_session_id AS destination_remote_session_id,
      publish_destinations.remote_upload_url_encrypted AS remote_upload_url_encrypted,
      publish_destinations.remote_post_id AS destination_remote_post_id,
      publish_destinations.remote_url AS remote_url,
      publish_destinations.upload_offset AS upload_offset,
      publish_destinations.next_poll_at AS next_poll_at,
      publish_destinations.last_error_code AS destination_last_error_code,
      publish_destinations.last_error_message AS destination_last_error_message,
      publish_destinations.outcome_unknown AS outcome_unknown,
      publish_destinations.published_at AS published_at,
      publish_destinations.transition_token AS transition_token,
      publish_destinations.created_at AS destination_created_at,
      publish_destinations.updated_at AS destination_updated_at,
      publish_attempts.id AS attempt_id,
      publish_attempts.attempt_number AS attempt_number,
      publish_attempts.workflow_instance_id AS attempt_workflow_instance_id,
      publish_attempts.status AS attempt_status,
      publish_attempts.stage AS attempt_stage,
      publish_attempts.remote_session_id AS attempt_remote_session_id,
      publish_attempts.remote_post_id AS attempt_remote_post_id,
      publish_attempts.error_code AS attempt_error_code,
      publish_attempts.error_message AS attempt_error_message,
      publish_attempts.started_at AS attempt_started_at,
      publish_attempts.finished_at AS attempt_finished_at,
      publish_attempts.updated_at AS attempt_updated_at,
      media_leases.id AS lease_id,
      media_leases.upload_id AS lease_upload_id,
      media_leases.purpose AS lease_purpose,
      media_leases.expires_at AS lease_expires_at,
      media_leases.revoked_at AS lease_revoked_at,
      media_leases.created_at AS lease_created_at
    FROM posts
    INNER JOIN publish_destinations ON publish_destinations.post_id = posts.id
    INNER JOIN publish_attempts ON publish_attempts.destination_id = publish_destinations.id
    INNER JOIN media_leases ON media_leases.destination_id = publish_destinations.id
    ORDER BY posts.id;`
  );
  const expectedDependentRows: QueryRow[] = [
    {
      post_id: "post-one",
      post_upload_id: "upload-one",
      destination_id: "destination-one",
      connection_id: "connection-fixture",
      platform: "youtube",
      settings_json: '{"fixture":1}',
      destination_status: "published",
      destination_stage: "complete",
      destination_attempt_number: 1,
      destination_workflow_instance_id: "workflow-one",
      destination_remote_session_id: "session-one",
      remote_upload_url_encrypted: "encrypted-upload-one",
      destination_remote_post_id: "remote-post-one",
      remote_url: "https://example.invalid/one",
      upload_offset: 1024,
      next_poll_at: 1100,
      destination_last_error_code: "destination-code-one",
      destination_last_error_message: "destination message one",
      outcome_unknown: 0,
      published_at: 1000,
      transition_token: null,
      destination_created_at: 1000,
      destination_updated_at: 1001,
      attempt_id: "attempt-one",
      attempt_number: 1,
      attempt_workflow_instance_id: "attempt-workflow-one",
      attempt_status: "published",
      attempt_stage: "complete",
      attempt_remote_session_id: "session-one",
      attempt_remote_post_id: "remote-post-one",
      attempt_error_code: "attempt-code-one",
      attempt_error_message: "attempt message one",
      attempt_started_at: 900,
      attempt_finished_at: 1000,
      attempt_updated_at: 1001,
      lease_id: "lease-one",
      lease_upload_id: "upload-one",
      lease_purpose: "youtube",
      lease_expires_at: 999999,
      lease_revoked_at: 900,
      lease_created_at: 1000
    },
    {
      post_id: "post-two",
      post_upload_id: "upload-two",
      destination_id: "destination-two",
      connection_id: "connection-fixture",
      platform: "youtube",
      settings_json: '{"fixture":2}',
      destination_status: "published",
      destination_stage: "complete",
      destination_attempt_number: 2,
      destination_workflow_instance_id: "workflow-two",
      destination_remote_session_id: "session-two",
      remote_upload_url_encrypted: "encrypted-upload-two",
      destination_remote_post_id: "remote-post-two",
      remote_url: "https://example.invalid/two",
      upload_offset: 2048,
      next_poll_at: 2100,
      destination_last_error_code: "destination-code-two",
      destination_last_error_message: "destination message two",
      outcome_unknown: 1,
      published_at: 2000,
      transition_token: null,
      destination_created_at: 2000,
      destination_updated_at: 2001,
      attempt_id: "attempt-two",
      attempt_number: 2,
      attempt_workflow_instance_id: "attempt-workflow-two",
      attempt_status: "published",
      attempt_stage: "complete",
      attempt_remote_session_id: "session-two",
      attempt_remote_post_id: "remote-post-two",
      attempt_error_code: "attempt-code-two",
      attempt_error_message: "attempt message two",
      attempt_started_at: 1900,
      attempt_finished_at: 2000,
      attempt_updated_at: 2001,
      lease_id: "lease-two",
      lease_upload_id: "upload-two",
      lease_purpose: "youtube",
      lease_expires_at: 1999999,
      lease_revoked_at: 1900,
      lease_created_at: 2000
    }
  ];
  expect(
    isDeepStrictEqual(dependentRows, expectedDependentRows),
    `${scenario.name}: dependent destination, attempt, or media-lease fields changed during upgrade. Received ${JSON.stringify(dependentRows)}.`
  );

  const deletionRows = query(
    scenario,
    `SELECT id, status, attempt_count, next_attempt_at, phase, failure_code,
      last_error, requested_at, completed_at, updated_at
    FROM deletion_requests
    ORDER BY id;`
  );
  const expectedDeletionRows: QueryRow[] = [
    {
      id: "deletion-complete",
      status: "complete",
      attempt_count: 1,
      next_attempt_at: null,
      phase: "complete",
      failure_code: null,
      last_error: null,
      requested_at: 800,
      completed_at: 1000,
      updated_at: 1200
    },
    {
      id: "deletion-failed",
      status: "retry_scheduled",
      attempt_count: 1,
      next_attempt_at: 1100,
      phase: "provider_cleanup",
      failure_code: "deletion_processing_failed",
      last_error: "old failure",
      requested_at: 900,
      completed_at: null,
      updated_at: 1100
    }
  ];
  expect(
    isDeepStrictEqual(deletionRows, expectedDeletionRows),
    `${scenario.name}: deletion-request backfills did not preserve the expected state. Received ${JSON.stringify(deletionRows)}.`
  );
};

const main = async (): Promise<void> => {
  assertGeneratedPath(rehearsalPath);
  await rm(rehearsalPath, { force: true, recursive: true });
  await mkdir(rehearsalPath, { recursive: true });

  const migrationNames = (
    await readdir(sourceMigrationsPath, {
      withFileTypes: true
    })
  )
    .filter(entry => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const requiredVersions = ["0000", "0001", "0002", "0003", "0004"];
  expect(
    requiredVersions.every(
      (version, index) =>
        migrationNames[index]?.startsWith(`${version}_`) === true
    ),
    `Expected migration history from 0000 through at least 0004, received ${JSON.stringify(migrationNames)}.`
  );

  const wranglerPackage: unknown = JSON.parse(
    await readFile(wranglerPackagePath, "utf8")
  );
  if (
    typeof wranglerPackage !== "object" ||
    wranglerPackage === null ||
    !("version" in wranglerPackage) ||
    typeof wranglerPackage.version !== "string"
  ) {
    throw new Error("The pinned Wrangler package version could not be read.");
  }
  process.stdout.write(
    `Rehearsing ${String(migrationNames.length)} migration(s) with local Wrangler ${wranglerPackage.version}.\n`
  );

  const fresh = await createScenario("fresh");
  process.stdout.write("Fresh database: applying 0000 through HEAD.\n");
  await copyMigrations(fresh, migrationNames);
  applyMigrations(fresh);
  verifySchema(fresh, migrationNames);

  const populated = await createScenario("populated-upgrade");
  process.stdout.write(
    "Populated upgrade: applying 0000, inserting relational fixtures, then applying HEAD.\n"
  );
  await copyMigrations(populated, migrationNames.slice(0, 1));
  applyMigrations(populated);
  const fixturePath = join(populated.rootPath, "fixture.sql");
  await writeFile(fixturePath, populatedFixture, "utf8");
  executeFile(populated, fixturePath);
  await copyMigrations(populated, migrationNames.slice(1));
  applyMigrations(populated);
  verifySchema(populated, migrationNames);
  verifyPopulatedData(populated);

  process.stdout.write(
    `Migration rehearsal passed. Local state remains at ${rehearsalPath}\n`
  );
};

await main();
