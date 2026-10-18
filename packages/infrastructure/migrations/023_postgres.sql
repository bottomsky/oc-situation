CREATE TABLE route_datasets (
 version text PRIMARY KEY, manifest jsonb NOT NULL, active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX route_datasets_active ON route_datasets(active) WHERE active;
CREATE TABLE route_land (
 dataset_version text NOT NULL REFERENCES route_datasets(version), id bigserial PRIMARY KEY,
 geom geometry(Geometry,4326) NOT NULL, geog geography(Geometry,4326) NOT NULL
);
CREATE INDEX route_land_geog ON route_land USING gist(geog);
CREATE TABLE route_nodes (
 dataset_version text NOT NULL REFERENCES route_datasets(version), id text NOT NULL,
 coordinate jsonb NOT NULL, geog geography(Point,4326) NOT NULL, PRIMARY KEY(dataset_version,id)
);
CREATE INDEX route_nodes_geog ON route_nodes USING gist(geog);
CREATE TABLE route_edges (
 dataset_version text NOT NULL REFERENCES route_datasets(version), id bigserial PRIMARY KEY,
 from_id text NOT NULL, to_id text NOT NULL, coordinates jsonb NOT NULL,
 geog geography(LineString,4326) NOT NULL, channel text NOT NULL DEFAULT 'open',
 FOREIGN KEY(dataset_version,from_id) REFERENCES route_nodes(dataset_version,id),
 FOREIGN KEY(dataset_version,to_id) REFERENCES route_nodes(dataset_version,id)
);
CREATE INDEX route_edges_geog ON route_edges USING gist(geog);
CREATE TABLE route_restrictions (
 version bigserial PRIMARY KEY, id uuid NOT NULL, revision integer NOT NULL, name text NOT NULL,
 geometry jsonb NOT NULL, geog geography(Geometry,4326) NOT NULL,
 valid_from timestamptz NOT NULL, valid_until timestamptz, enabled boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,revision),
 CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE INDEX route_restrictions_geog ON route_restrictions USING gist(geog);
CREATE TABLE route_plans (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
 input jsonb NOT NULL, dataset_version text REFERENCES route_datasets(version), restriction_version bigint NOT NULL,
 result jsonb, error text, claimed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX route_plans_queued ON route_plans(created_at) WHERE status='queued';
CREATE TABLE routes (
 id uuid PRIMARY KEY, revision integer NOT NULL, document jsonb NOT NULL,
 geog geography(LineString,4326) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routes_geog ON routes USING gist(geog);
CREATE TABLE route_revisions (
 route_id uuid NOT NULL REFERENCES routes(id), revision integer NOT NULL, document jsonb NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(route_id,revision)
);
CREATE TABLE route_operation_receipts (
 user_id uuid NOT NULL REFERENCES users(id), operation_id uuid NOT NULL, input_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,operation_id)
);
