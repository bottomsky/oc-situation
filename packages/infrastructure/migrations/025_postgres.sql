ALTER TABLE route_datasets
  ADD COLUMN navigation_status text NOT NULL DEFAULT 'unprepared'
    CHECK(navigation_status IN ('unprepared','preparing','ready','failed')),
  ADD COLUMN navigation_checked_edges integer NOT NULL DEFAULT 0,
  ADD COLUMN navigation_prepared_at timestamptz,
  ADD COLUMN navigation_error text;
ALTER TABLE route_edges ADD COLUMN base_navigable boolean;
CREATE INDEX route_edges_base_navigable ON route_edges(dataset_version,id) WHERE base_navigable;
CREATE INDEX route_edges_unprepared ON route_edges(dataset_version,id) WHERE base_navigable IS NULL;
