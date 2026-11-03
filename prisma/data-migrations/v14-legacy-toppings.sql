-- Explicit one-time data conversion. Run only after reviewing the TOPPING groups in this DB.
-- The transaction aborts on ambiguity; no old option/history row is deleted.
BEGIN;
LOCK TABLE menu_option_groups, menu_options, menu_item_option_groups, menu_extras, menu_item_extras, branch_menu_options, branch_menu_extras IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM menu_options o JOIN menu_option_groups g ON g.id=o.group_id
   WHERE upper(g.code)='TOPPING' AND o.price_delta < 0) THEN
   RAISE EXCEPTION 'Negative legacy topping prices require manual review';
 END IF;
 IF EXISTS (SELECT 1 FROM menu_options o JOIN menu_option_groups g ON g.id=o.group_id
   JOIN menu_extras e ON e.chain_id=g.chain_id AND e.name=o.name AND e.id<>o.id
   WHERE upper(g.code)='TOPPING') OR EXISTS (
   SELECT g.chain_id, o.name FROM menu_options o JOIN menu_option_groups g ON g.id=o.group_id
   WHERE upper(g.code)='TOPPING' GROUP BY g.chain_id,o.name HAVING count(*)>1) THEN
   RAISE EXCEPTION 'Ambiguous legacy topping names; resolve before conversion';
 END IF;
END $$;
INSERT INTO menu_extras(id,chain_id,name,price,is_active,created_at,updated_at)
 SELECT o.id,g.chain_id,o.name,o.price_delta,o.is_active AND g.is_active,o.created_at,o.updated_at
 FROM menu_options o JOIN menu_option_groups g ON g.id=o.group_id WHERE upper(g.code)='TOPPING'
 ON CONFLICT(id) DO NOTHING;
INSERT INTO menu_item_extras(menu_item_id,extra_id,price,max_quantity,display_order)
 SELECT l.menu_item_id,o.id,o.price_delta,3,o.display_order FROM menu_item_option_groups l
 JOIN menu_option_groups g ON g.id=l.group_id JOIN menu_options o ON o.group_id=g.id
 WHERE upper(g.code)='TOPPING' ON CONFLICT(menu_item_id,extra_id) DO NOTHING;
INSERT INTO branch_menu_extras(branch_id,extra_id,is_available)
 SELECT b.branch_id,b.option_id,b.is_available FROM branch_menu_options b
 JOIN menu_options o ON o.id=b.option_id JOIN menu_option_groups g ON g.id=o.group_id
 WHERE upper(g.code)='TOPPING' ON CONFLICT(branch_id,extra_id) DO NOTHING;
-- Detach only after all corresponding links were copied. Old snapshots still reference existing options.
DELETE FROM menu_item_option_groups l USING menu_option_groups g
 WHERE l.group_id=g.id AND upper(g.code)='TOPPING';
-- Do not change group.is_active: rerunning the script must not reinterpret the original flags.
COMMIT;
