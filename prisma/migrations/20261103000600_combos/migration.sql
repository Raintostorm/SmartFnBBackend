CREATE TABLE combos (
 id UUID PRIMARY KEY, chain_id UUID NOT NULL REFERENCES restaurant_chains(id) ON DELETE RESTRICT,
 category_id UUID NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
 name VARCHAR(150) NOT NULL, description TEXT, image_url VARCHAR(500), price DECIMAL(14,2) NOT NULL CHECK(price>=0),
 is_active BOOLEAN NOT NULL DEFAULT true, display_order INTEGER NOT NULL DEFAULT 0,
 deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX combos_chain_id_is_active_display_order_idx ON combos(chain_id,is_active,display_order);
CREATE TABLE combo_components (
 id UUID PRIMARY KEY, combo_id UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
 type VARCHAR(10) NOT NULL CHECK(type IN ('FIXED','CHOICE')), name VARCHAR(100) NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 5), fixed_size_code VARCHAR(50), display_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX combo_components_combo_id_display_order_idx ON combo_components(combo_id,display_order);
CREATE TABLE combo_component_choices (
 id UUID PRIMARY KEY, component_id UUID NOT NULL REFERENCES combo_components(id) ON DELETE CASCADE,
 menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
 surcharge DECIMAL(14,2) NOT NULL DEFAULT 0 CHECK(surcharge>=0), is_default BOOLEAN NOT NULL DEFAULT false,
 UNIQUE(component_id,menu_item_id)
);
CREATE TABLE branch_combos (
 branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
 combo_id UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
 is_enabled BOOLEAN NOT NULL DEFAULT true, is_available BOOLEAN NOT NULL DEFAULT true,
 price_override DECIMAL(14,2) CHECK(price_override>=0), PRIMARY KEY(branch_id,combo_id)
);
ALTER TABLE order_items ALTER COLUMN menu_item_id DROP NOT NULL;
ALTER TABLE order_items ADD COLUMN line_type VARCHAR(20) NOT NULL DEFAULT 'ITEM',
 ADD COLUMN combo_id UUID REFERENCES combos(id) ON DELETE RESTRICT,
 ADD COLUMN parent_id UUID REFERENCES order_items(id) ON DELETE RESTRICT,
 ADD COLUMN combo_name VARCHAR(150);
ALTER TABLE order_items ADD CONSTRAINT order_items_line_kind_check CHECK (
 (line_type='ITEM' AND menu_item_id IS NOT NULL AND combo_id IS NULL AND parent_id IS NULL) OR
 (line_type='COMBO' AND menu_item_id IS NULL AND combo_id IS NOT NULL AND parent_id IS NULL) OR
 (line_type='COMBO_COMPONENT' AND menu_item_id IS NOT NULL AND combo_id IS NULL AND parent_id IS NOT NULL AND unit_price=0 AND total_price=0)
);
ALTER TABLE order_items ADD CONSTRAINT order_items_order_id_id_unique UNIQUE(order_id,id);
ALTER TABLE order_items ADD CONSTRAINT order_items_parent_order_fk FOREIGN KEY(order_id,parent_id) REFERENCES order_items(order_id,id) ON DELETE RESTRICT;
CREATE INDEX order_items_parent_id_idx ON order_items(parent_id);
