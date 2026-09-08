<?php
/** PHP bridge unit test with in-memory Db/native-widget doubles; no site or database connection. */
namespace Typecho\Plugin { interface PluginInterface {} }
namespace Widget { interface ActionInterface {} }
namespace Typecho {
    class Widget {}
    class Db {
        const WRITE = 2;
        const SORT_ASC = 'ASC';
        const SORT_DESC = 'DESC';
        public static $fixture;
        public $tables = [], $backup = null, $cleanup = [], $failReceipt = false, $commentsEngine = 'InnoDB';
        public function getPrefix() { return 'typecho_'; }
        public function select(...$columns) { return new \QueryDouble('select'); }
        public function sql() { return new \QueryDouble('select'); }
        public function insert($table) { return (new \QueryDouble('insert'))->from($table); }
        public function delete($table) { return (new \QueryDouble('delete'))->from($table); }
        public function query($q, $mode = null) {
            if (is_string($q)) {
                if ($q === 'START TRANSACTION') $this->backup = unserialize(serialize($this->tables));
                if ($q === 'COMMIT') $this->backup = null;
                if ($q === 'ROLLBACK') { $this->tables = $this->backup; $this->backup = null; }
                return 0;
            }
            if ($q->kind === 'insert') {
                if ($this->failReceipt && $q->table === 'table.dsh_blog_receipts') throw new \RuntimeException('receipt failed');
                $this->tables[$q->table][] = $q->values; return 1;
            }
            $before = count($this->tables[$q->table] ?? []);
            $this->tables[$q->table] = array_values(array_filter($this->tables[$q->table] ?? [], fn($r) => !$q->matches($r)));
            return $before - count($this->tables[$q->table]);
        }
        public function fetchAll($q) {
            if ($q === 'SHOW TABLE STATUS') return array_map(fn($name) => ['Name' => 'typecho_' . $name, 'Engine' => $name === 'comments' ? $this->commentsEngine : 'InnoDB'], ['contents','fields','relationships','metas','comments','dsh_blog_receipts']);
            return array_slice(array_values(array_filter($this->tables[$q->table] ?? [], fn($r) => $q->matches($r))), $q->skip, $q->take);
        }
        public function fetchRow($q) { return $this->fetchAll($q)[0] ?? null; }
    }
}
namespace Widget\Contents\Post {
    class Edit {
        public $db, $cid, $type, $status;
        public static function allocWithAlias($alias, $unused, $args) {
            $self = new static(); $self->db = \Typecho\Db::$fixture;
            $row = $self->db->fetchRow($self->db->select()->from('table.contents')->where('cid = ?', $args['cid']));
            foreach (['cid','type','status'] as $key) $self->$key = $row[$key];
            return $self;
        }
        public function allow($permission) { return true; }
        public function delete($query) { $query->kind = 'delete'; $query->table = 'table.contents'; return $this->db->query($query); }
        public function setCategories($cid, $values, $before, $after) { $this->db->cleanup[] = ['categories',$cid,$before,$after]; }
        public function setTags($cid, $values, $before, $after) { $this->db->cleanup[] = ['tags',$cid,$before,$after]; }
        protected function unAttach($cid) { $this->db->cleanup[] = ['detach',$cid]; }
        public function deleteFields($cid) { $this->db->query($this->db->delete('table.fields')->where('cid = ?', $cid)); }
        protected function deleteDraft($cid) { $this->delete($this->db->sql()->where('cid = ?', $cid)); $this->setCategories($cid, [], false, false); $this->setTags($cid, null, false, false); }
    }
}
namespace {
    class QueryDouble {
        public $kind, $table, $conditions = [], $values, $skip = 0, $take = null;
        public function __construct($kind) { $this->kind = $kind; }
        public function from($table) { $this->table = $table; return $this; }
        public function join(...$args) { return $this; }
        public function order(...$args) { return $this; }
        public function limit($n) { $this->take=$n; return $this; }
        public function offset($n) { $this->skip=$n; return $this; }
        public function rows($values) { $this->values = $values; return $this; }
        public function where($sql, ...$values) { $this->conditions[] = [$sql, $values]; return $this; }
        public function matches($row) {
            foreach ($this->conditions as [$sql, $values]) {
                if (str_contains($sql, 'LOCATE')) { if (!str_contains($row['title'], $values[0]) && !str_contains($row['text'], $values[1])) return false; continue; }
                preg_match_all('/(?:table\.[a-z_]+\.)?([a-z_]+) (=|<>) \?/', $sql, $matches);
                $terms = []; foreach ($matches[1] as $i => $key) $terms[] = $matches[2][$i] === '=' ? ($row[$key] ?? null) == $values[$i] : ($row[$key] ?? null) != $values[$i];
                if (str_contains($sql, ' OR ') ? !in_array(true, $terms, true) : in_array(false, $terms, true)) return false;
            }
            return true;
        }
    }
    if (!function_exists('mb_strlen')) { function mb_strlen($s) { return strlen($s); } }
    define('__TYPECHO_ROOT_DIR__', __DIR__);
    require __DIR__ . '/../typecho/DshBlogBridge/Plugin.php';
    function check($value, $message) { if (!$value) throw new \RuntimeException($message); }
    function fixture() {
        $db = new \Typecho\Db(); \Typecho\Db::$fixture = $db;
        $row = fn($cid, $type, $parent) => ['cid'=>$cid,'type'=>$type,'parent'=>$parent,'status'=>'publish','title'=>'fixture','text'=>'body','slug'=>'fixture'];
        $db->tables = ['table.contents'=>[$row(338,'post',0),$row(339,'post_draft',338),$row(500,'post',0)],'table.comments'=>[['cid'=>338],['cid'=>339],['cid'=>500]],'table.fields'=>[['cid'=>338,'name'=>'custom'],['cid'=>339,'name'=>'draft']],'table.dsh_blog_receipts'=>[]];
        $ref = new \ReflectionClass('DshBlogBridge_Action'); $action = $ref->newInstanceWithoutConstructor();
        $ref->getProperty('bridgeDb')->setValue($action, $db); $ref->getProperty('bridgeUser')->setValue($action, (object)['uid'=>1]);
        $snapshot = $ref->getMethod('snapshot')->invoke($action,338);
        $input = ['cid'=>338,'requestId'=>'00000000-0000-4000-8000-000000000001','base'=>$snapshot];
        $run = function ($args) use ($ref,$action,$db) {
            try { return $ref->getMethod('deleteArticle')->invoke($action,$args); }
            catch (\Throwable $e) { if ($db->backup !== null) $db->query('ROLLBACK'); throw $e; }
        };
        return [$db,$action,$ref,$input,$run];
    }
    function rejects($run, $input, $code) { try { $run($input); } catch (\Throwable $e) { check($e->getCode() === $code,'unexpected rejection: '.$e->getMessage()); return; } throw new \RuntimeException('expected rejection'); }
    [$db,$action,$ref,$input,$run] = fixture();
    $result = $run($input);
    check($result['deletedCids'] === [338,339], 'root and saved draft removed');
    check(array_column($db->tables['table.contents'],'cid') === [500], 'other article preserved');
    check(array_column($db->tables['table.comments'],'cid') === [500], 'only target comments removed');
    check($db->tables['table.fields'] === [], 'custom fields removed');
    check(in_array(['categories',338,true,false],$db->cleanup,true), 'published category count decremented');
    check(in_array(['categories',339,false,false],$db->cleanup,true), 'draft category count untouched');
    check(count($db->tables['table.dsh_blog_receipts']) === 1 && $db->backup === null, 'receipt committed with deletion');
    check($run($input) === $result, 'retry returns original receipt after target disappears');
    $changed = $input; $changed['cid'] = 500; rejects($run,$changed,409);
    $ref->getProperty('bridgeUser')->setValue($action,(object)['uid'=>2]); rejects($run,$input,409);
    [$db,$action,$ref,$input,$run] = fixture(); $original = $db->tables;
    $changed = $input; $changed['base']['version'] = str_repeat('0',64); rejects($run,$changed,409); check($db->tables === $original,'stale version leaves all tables unchanged');
    $changed = $input; $changed['cid'] = 339; rejects($run,$changed,409); check($db->tables === $original,'child draft cannot delete its parent');
    $db->failReceipt = true; rejects($run,$input,0); check($db->tables === $original,'receipt failure rolls deletion back');
    $db->failReceipt = false; $db->commentsEngine = 'MyISAM'; rejects($run,$input,503); check($db->tables === $original,'nontransactional comments block deletion');
    [$db,$action,$ref] = fixture();
    $rows = [];
    for ($i=0;$i<35;$i++) {
        $rows[] = ['cid'=>1000+$i,'type'=>'post','parent'=>0,'status'=>'publish','title'=>'文章'.$i,'text'=>'100%_正文','modified'=>$i];
        $rows[] = ['cid'=>2000+$i,'type'=>'post_draft','parent'=>0,'status'=>'draft','title'=>'草稿'.$i,'text'=>'待发布','modified'=>$i];
    }
    $rows[] = ['cid'=>3000,'type'=>'post_draft','parent'=>1000,'status'=>'draft','title'=>'关联保存稿','text'=>'修改','modified'=>100];
    $db->tables['table.contents']=$rows;
    $list=fn($args)=>$ref->getMethod('posts')->invoke($action,$args);
    $first=$list(['status'=>'published']);$second=$list(['status'=>'published','page'=>2]);$drafts=$list(['status'=>'draft']);
    check(count($first['items'])===30 && $first['hasMore'] && count($second['items'])===5 && !$second['hasMore'], 'status filtering must precede pagination');
    check(array_filter($first['items'],fn($r)=>!$r['hasPublished'])===[] && $first['items'][0]['hasSavedDraft'], 'published badge plus saved draft');
    check(count($drafts['items'])===30 && array_filter($drafts['items'],fn($r)=>$r['hasPublished'])===[], 'draft filter excludes published roots and child drafts');
    check(count($list(['status'=>'all','query'=>'%_'])['items'])===30, 'search treats percent and underscore literally');
    rejects($list,['status'=>'invalid'],400);
    [$db,$action,$ref,$input,$run] = fixture();
    $db->tables['table.contents'][0]['views']=10;
    $db->tables['table.contents'][1]['views']=3;
    $base=$ref->getMethod('snapshot')->invoke($action,338);
    $db->tables['table.contents'][0]['views']=11;
    $db->tables['table.contents'][1]['views']=4;
    $current=$ref->getMethod('snapshot')->invoke($action,338);
    check($base['version']===$current['version'],'view increments must not invalidate article previews');
    check($current['published']['raw']['views']===11 && $current['savedDraft']['raw']['views']===4,'raw snapshots still retain current view counters');
    foreach (['title'=>'changed','text'=>'changed','status'=>'private','modified'=>100,'commentsNum'=>1] as $key=>$value) {
        $original=$db->tables['table.contents'][0];$db->tables['table.contents'][0][$key]=$value;
        check($ref->getMethod('snapshot')->invoke($action,338)['version']!==$base['version'],'real changes still invalidate previews: '.$key);
        $db->tables['table.contents'][0]=$original;
    }
    $input['base']=$base;
    check($run($input)['deletedCids']===[338,339],'view increments between preview and confirmation do not block the operation');
    echo "PASS: view counters excluded from versions, raw counters retained, content and metadata conflicts protected (Db/widget doubles)\n";
    echo "PASS: library status filters before pagination, saved draft flags, literal search and invalid status (Db double)\n";
    echo "PASS: bridge deletion scope, native cleanup calls, receipt replay, actor/hash conflict, stale version, child ID guard and transactional rollback (Db/widget doubles)\n";
}
