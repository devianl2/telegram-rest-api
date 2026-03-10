-- CreateTable: tenants must exist before telegram_sessions references it
CREATE TABLE "tenants" (
    "id" SERIAL NOT NULL,
    "secret_id" VARCHAR(20) NOT NULL,
    "secret_code" VARCHAR(50) NOT NULL,
    "server_name" VARCHAR(255) NOT NULL,
    "callback_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_secret_id_key" ON "tenants"("secret_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_secret_code_key" ON "tenants"("secret_code");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_server_name_key" ON "tenants"("server_name");

-- RecreatTable: PostgreSQL does not support column reordering via ALTER TABLE.
-- Drop and recreate telegram_sessions so that tenant_id is placed after id.
DROP TABLE IF EXISTS "telegram_sessions";

CREATE TABLE "telegram_sessions" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "session_id" TEXT NOT NULL,
    "telegram_user_id" VARCHAR(255) NOT NULL,
    "telegram_username" VARCHAR(255) NOT NULL,
    "telegram_access_hash" VARCHAR(255) NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_sessions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "telegram_sessions" ADD CONSTRAINT "telegram_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
