<?php
/**
 * DSH 博客原文与确认提交桥接。使用 Typecho 原生内容组件，分离公开版和保存稿。
 * @package DshBlogBridge
 * @author DPL
 * @version 0.4.0
 * @link https://pelyblog.com/
 */
if (!defined('__TYPECHO_ROOT_DIR__')) { exit; }

require_once __DIR__ . '/Management.php';

class DshBlogBridge_Plugin implements \Typecho\Plugin\PluginInterface
{
    public static function activate()
    {
        $db = \Typecho\Db::get();
        if ($db->getAdapterName() !== 'Pdo_Mysql') { throw new \Typecho\Plugin\Exception('需要 Pdo_Mysql'); }
        $table = $db->getPrefix() . 'dsh_blog_receipts';
        if (!preg_match('/^[a-zA-Z0-9_]+$/', $table)) { throw new \Typecho\Plugin\Exception('数据库前缀无效'); }
        $db->query("CREATE TABLE IF NOT EXISTS `{$table}` (request_id varchar(100) NOT NULL PRIMARY KEY, uid int unsigned NOT NULL, input_hash char(64) NOT NULL, result longtext NOT NULL, created_at bigint NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4", \Typecho\Db::WRITE);
        \Utils\Helper::addAction('dsh-blog-bridge', 'DshBlogBridge_Action');
    }
    public static function deactivate() { \Utils\Helper::removeAction('dsh-blog-bridge'); }
    public static function config(\Typecho\Widget\Helper\Form $form) {}
    public static function personalConfig(\Typecho\Widget\Helper\Form $form) {}
}

/** All widget reads and writes in this request share one transaction connection. */
class DshBlogBridge_Db extends \Typecho\Db
{
    public function selectDb(int $op) { return parent::selectDb(\Typecho\Db::WRITE); }
}

class DshBlogBridge_Error extends \RuntimeException
{
    public $publicCode;
    public function __construct(string $code, int $status) { parent::__construct($code, $status); $this->publicCode = $code; }
}

/** Native save/publish without HTTP redirects, ping dispatch or form-only theme callbacks. */
class DshBlogBridge_Edit extends \Widget\Contents\Post\Edit
{
    public $preservedFields = [];
    public function filter(array $value): array { return \Widget\Base\Contents::filter($value); }
    protected function getFields(): array { return $this->preservedFields; }
    public function commitArticle(array $contents, bool $publish): int
    {
        if ($publish) { $this->publish($contents); return (int) $this->cid; }
        $this->save($contents);
        // Re-query the saved draft because the widget's computed draft value may be cached.
        if ($this->type === 'post_draft') { return (int) $this->cid; }
        $row = $this->db->fetchRow($this->db->select('cid')->from('table.contents')
            ->where('parent = ? AND type = ?', $this->cid, 'post_draft')->limit(1));
        return (int) ($row['cid'] ?? 0);
    }
    /** Use native content cleanup helpers without admin redirects or theme form hooks. */
    public function removeArticle(): array
    {
        $cid = (int) $this->cid;
        $draft = $this->db->fetchRow($this->db->select('cid')->from('table.contents')
            ->where('parent = ? AND type = ?', $cid, 'post_draft')->limit(1));
        $counted = $this->type === 'post' && $this->status === 'publish';
        if (!$this->allow('edit') || !$this->delete($this->db->sql()->where('cid = ?', $cid))) {
            throw new DshBlogBridge_Error('conflict', 409);
        }
        $this->setCategories($cid, [], $counted, false);
        $this->setTags($cid, null, $counted, false);
        $this->db->query($this->db->delete('table.comments')->where('cid = ?', $cid));
        $this->unAttach($cid);
        $this->deleteFields($cid);
        $ids = [$cid];
        if ($draft) {
            $draftId = (int) $draft['cid'];
            $this->deleteDraft($draftId);
            $this->deleteFields($draftId);
            $this->unAttach($draftId);
            $this->db->query($this->db->delete('table.comments')->where('cid = ?', $draftId));
            $ids[] = $draftId;
        }
        return $ids;
    }
}

class DshBlogBridge_Action extends \Typecho\Widget implements \Widget\ActionInterface
{
    use DshBlogBridge_Management;
    private $bridgeDb;
    private $bridgeUser;
    private $transaction = false;
    private $outputLevel;
    private function demand($condition, string $code = 'invalid', int $status = 400)
    {
        if (!$condition) { throw new DshBlogBridge_Error($code, $status); }
    }
    public function action()
    {
        $this->outputLevel = ob_get_level(); ob_start();
        try {
            $this->demand(($_SERVER['REQUEST_METHOD'] ?? '') === 'POST', 'invalid', 405);
            $this->demand(stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') === 0, 'invalid', 415);
            $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
            if (isset($_SERVER['PHP_AUTH_USER'])) {
                $username = $_SERVER['PHP_AUTH_USER']; $password = $_SERVER['PHP_AUTH_PW'] ?? '';
            } else {
                $this->demand(stripos($authorization, 'Basic ') === 0, 'unauthorized', 401);
                $decoded = base64_decode(substr($authorization, 6), true);
                $this->demand(is_string($decoded) && strpos($decoded, ':') !== false, 'unauthorized', 401);
                [$username, $password] = explode(':', $decoded, 2);
            }
            $this->bridgeUser = \Widget\User::alloc();
            $this->demand($this->bridgeUser->login($username, $password, true), 'unauthorized', 401);
            unset($password, $decoded, $authorization);
            $this->demand($this->bridgeUser->pass('editor', true), 'forbidden', 403);
            $raw = file_get_contents('php://input', false, null, 0, 4 * 1024 * 1024 + 1);
            $this->demand(strlen($raw) <= 4 * 1024 * 1024, 'invalid', 413);
            $input = json_decode($raw, true);
            $this->demand(is_array($input) && ($input['protocolVersion'] ?? null) === 1);
            $original = \Typecho\Db::get();
            $this->demand($original->getAdapterName() === 'Pdo_Mysql', 'incompatible', 503);
            $this->bridgeDb = new DshBlogBridge_Db($original->getAdapterName(), $original->getPrefix());
            $this->bridgeDb->addServer($original->getConfig(\Typecho\Db::WRITE)->toArray(), \Typecho\Db::READ | \Typecho\Db::WRITE);
            \Typecho\Db::set($this->bridgeDb);
            $action = $input['action'] ?? '';
            if ($action === 'status') { $data = $this->status(); }
            elseif ($action === 'list') { $data = $this->posts($input); }
            elseif ($action === 'search') { $data = $this->searchPosts($input); }
            elseif ($action === 'get') { $data = $this->snapshot($this->id($input['cid'] ?? null)); }
            elseif ($action === 'save') { $data = $this->saveArticle($input); }
            elseif ($action === 'delete') { $data = $this->deleteArticle($input); }
            elseif ($action === 'manage-list') { $data = $this->managementList($input); }
            elseif ($action === 'manage-get') { $data = $this->managementGet($input); }
            elseif ($action === 'manage-preview') { $data = $this->managementPreview($input); }
            elseif ($action === 'manage-write') { $data = $this->managementWrite($input); }
            elseif ($action === 'receipt') { $data = $this->receipt($input); }
            else { throw new DshBlogBridge_Error('invalid', 400); }
            $this->respond(200, ['ok' => true, 'data' => $data]);
        } catch (\Throwable $error) {
            if ($this->transaction) { try { $this->bridgeDb->query('ROLLBACK', \Typecho\Db::WRITE); } catch (\Throwable $ignored) {} }
            $expected = $error instanceof DshBlogBridge_Error;
            if (!$expected) { error_log('DSH bridge failure ' . get_class($error) . ' at ' . basename($error->getFile()) . ':' . $error->getLine()); }
            $this->respond($expected ? $error->getCode() : 503, ['ok' => false, 'code' => $expected ? $error->publicCode : 'incompatible']);
        }
    }
    private function respond(int $status, array $body)
    {
        while (ob_get_level() > $this->outputLevel) { ob_end_clean(); }
        $response = \Typecho\Response::getInstance();
        $response->setStatus($status)->setHeader('Content-Type', 'application/json; charset=utf-8')->setHeader('Cache-Control', 'no-store');
        $response->sendHeaders();
        echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $response->respond();
    }
    private function id($value): int { $this->demand(is_int($value) && $value > 0); return $value; }
    private function status(): array
    {
        $db = $this->bridgeDb;
        $this->demand(preg_match('/^[a-zA-Z0-9_]+$/', $db->getPrefix()), 'incompatible', 503);
        $tables = $db->fetchAll('SHOW TABLE STATUS'); $engines = [];
        foreach ($tables as $table) { $engines[$table['Name']] = $table['Engine']; }
        foreach (['contents', 'fields', 'relationships', 'metas', 'comments', 'dsh_blog_receipts'] as $name) {
            $this->demand(($engines[$db->getPrefix() . $name] ?? '') === 'InnoDB', 'incompatible', 503);
        }
        $categories = $db->fetchAll($db->select('mid', 'name')->from('table.metas')->where('type = ?', 'category')->order('order', \Typecho\Db::SORT_ASC));
        return ['protocolVersion' => 1, 'version' => '0.4.0', 'structuredSearch' => true, 'nativeDrafts' => true, 'management' => true, 'deleteArticle' => true, 'categories' => array_map(function ($r) { return ['id' => (int) $r['mid'], 'name' => $r['name']]; }, $categories), 'losslessRaw' => true];
    }
    private function posts(array $input): array
    {
        $query = $input['query'] ?? ''; $page = $input['page'] ?? 1; $status = $input['status'] ?? 'all';
        $this->demand(in_array($status, ['all','published','draft'], true));
        $this->demand(is_string($query) && mb_strlen($query) <= 200 && is_int($page) && $page > 0 && $page <= 10000);
        $db = $this->bridgeDb;
        $sql = $db->select('cid', 'title', 'type', 'status', 'modified')->from('table.contents')
            ->where('type = ? OR type = ?', 'post', 'post_draft')->where('parent = ?', 0);
        if ($status === 'published') { $sql->where('type = ? AND status = ?', 'post', 'publish'); }
        elseif ($status === 'draft') { $sql->where('type = ? OR status <> ? OR cid IN (SELECT parent FROM ' . $db->getPrefix() . 'contents WHERE type = ? AND parent > 0)', 'post_draft', 'publish', 'post_draft'); }
        if ($query !== '') { $sql->where('LOCATE(?, title) > 0 OR LOCATE(?, text) > 0 OR cid IN (SELECT parent FROM ' . $db->getPrefix() . 'contents WHERE type = ? AND parent > 0 AND (LOCATE(?, title) > 0 OR LOCATE(?, text) > 0))', $query, $query, 'post_draft', $query, $query); }
        $rows = $db->fetchAll($sql->order('modified', \Typecho\Db::SORT_DESC)->offset(($page - 1) * 30)->limit(31));
        $items = [];
        foreach (array_slice($rows, 0, 30) as $row) {
            $child = $db->fetchRow($db->select('cid', 'title', 'modified')->from('table.contents')->where('parent = ? AND type = ?', $row['cid'], 'post_draft')->limit(1));
            $items[] = ['cid' => (int) $row['cid'], 'title' => html_entity_decode($child['title'] ?? $row['title'] ?? '', ENT_QUOTES, 'UTF-8'), 'hasPublished' => $row['type'] === 'post' && $row['status'] === 'publish', 'hasSavedDraft' => $row['type'] === 'post_draft' || !!$child, 'modified' => max((int) $row['modified'], (int) ($child['modified'] ?? 0))];
        }
        return ['items' => $items, 'status' => $status, 'hasMore' => count($rows) > 30];
    }
    private function searchPosts(array $input): array
    {
        $db = $this->bridgeDb;
        $f = [];
        foreach (['query', 'title', 'content', 'category', 'tag'] as $key) {
            $value = $input[$key] ?? '';
            $this->demand(is_string($value) && mb_strlen($value) <= 200);
            $f[$key] = trim($value);
        }
        $page = $input['page'] ?? 1;
        $dateField = $input['dateField'] ?? 'modified'; $sortBy = $input['sortBy'] ?? 'modified';
        $order = $input['order'] ?? 'desc'; $status = $input['status'] ?? 'all';
        $start = $input['start'] ?? null; $end = $input['end'] ?? null;
        $this->demand(is_int($page) && $page > 0 && $page <= 10000);
        $this->demand(in_array($dateField, ['created','modified'], true) && in_array($sortBy, ['created','modified'], true));
        $this->demand(in_array($order, ['asc','desc'], true) && in_array($status, ['all','published','draft'], true));
        $this->demand(($start === null || (is_int($start) && $start >= 0)) && ($end === null || (is_int($end) && $end >= 0)));
        $this->demand($start === null || $end === null || $start < $end);
        $sql = $db->select('DISTINCT table.contents.*')->from('table.contents')->where('table.contents.type = ? OR table.contents.type = ?', 'post', 'post_draft');
        if ($status === 'published') { $sql->where('table.contents.type = ? AND status = ?', 'post', 'publish'); }
        elseif ($status === 'draft') { $sql->where('table.contents.type = ? OR status <> ?', 'post_draft', 'publish'); }
        // LOCATE uses literal substrings: user '%' and '_' are not SQL wildcards.
        if ($f['query'] !== '') { $sql->where('LOCATE(?, title) > 0 OR LOCATE(?, text) > 0', $f['query'], $f['query']); }
        if ($f['title'] !== '') { $sql->where('LOCATE(?, title) > 0', $f['title']); }
        if ($f['content'] !== '') { $sql->where('LOCATE(?, text) > 0', $f['content']); }
        foreach (['category','tag'] as $type) {
            if ($f[$type] !== '') {
                $sql->join('table.relationships ' . $type . '_rel', $type . '_rel.cid = table.contents.cid')
                    ->join('table.metas ' . $type . '_meta', $type . '_meta.mid = ' . $type . '_rel.mid')
                    ->where($type . '_meta.type = ? AND ' . $type . '_meta.name = ?', $type, $f[$type]);
            }
        }
        if ($start !== null) { $sql->where('table.contents.' . $dateField . ' >= ?', $start); }
        if ($end !== null) { $sql->where('table.contents.' . $dateField . ' < ?', $end); }
        $direction = $order === 'asc' ? \Typecho\Db::SORT_ASC : \Typecho\Db::SORT_DESC;
        $rows = $db->fetchAll($sql->order('table.contents.' . $sortBy, $direction)->order('table.contents.cid', $direction)->offset(($page - 1) * 30)->limit(31));
        $items = [];
        foreach (array_slice($rows, 0, 30) as $row) {
            $published = $row['type'] === 'post' && $row['status'] === 'publish';
            $metas = $db->fetchAll($db->select('table.metas.mid','table.metas.name','table.metas.type')->from('table.metas')
                ->join('table.relationships','table.relationships.mid = table.metas.mid')->where('table.relationships.cid = ?', $row['cid']));
            $tags = []; $categories = [];
            foreach ($metas as $meta) {
                $term = ['id' => (int) $meta['mid'], 'name' => $meta['name']];
                if ($meta['type'] === 'category') { $categories[] = $term; } elseif ($meta['type'] === 'tag') { $tags[] = $term; }
            }
            $url = $published ? (\Widget\Base\Contents::alloc()->filter($row)['permalink'] ?? null) : null;
            $items[] = ['cid' => (int) $row['cid'], 'rootCid' => (int) ($row['parent'] ?: $row['cid']),
                'title' => html_entity_decode($row['title'] ?? '', ENT_QUOTES, 'UTF-8'),
                'variant' => $row['type'] === 'post_draft' ? 'savedDraft' : 'post', 'status' => $row['status'], 'hasPublished' => $published,
                'created' => (int) $row['created'], 'modified' => (int) $row['modified'],
                'createdAt' => gmdate('c', (int) $row['created']), 'modifiedAt' => gmdate('c', (int) $row['modified']),
                'tags' => $tags, 'categories' => $categories, 'url' => $url];
        }
        return ['items' => $items, 'page' => $page, 'hasMore' => count($rows) > 30,
            'dateNote' => 'created是Typecho设定的文章时间，modified是该版本最近修改时间；保存稿单独返回，不等于已发布。'];
    }
    private function row(int $cid): ?array
    {
        return $this->bridgeDb->fetchRow($this->bridgeDb->select()->from('table.contents')->where('cid = ?', $cid)->where('type = ? OR type = ?', 'post', 'post_draft'));
    }
    private function variant(array $row): array
    {
        $db = $this->bridgeDb; $cid = (int) $row['cid'];
        $metas = $db->fetchAll($db->select('table.metas.*')->from('table.metas')->join('table.relationships', 'table.relationships.mid = table.metas.mid')->where('table.relationships.cid = ?', $cid)->order('table.metas.mid', \Typecho\Db::SORT_ASC));
        $fields = $db->fetchAll($db->select()->from('table.fields')->where('cid = ?', $cid)->order('name', \Typecho\Db::SORT_ASC));
        $text = $row['text'] ?? ''; $markdown = strpos($text, '<!--markdown-->') === 0;
        $tags = []; $categories = [];
        foreach ($metas as $meta) { $m = ['id' => (int) $meta['mid'], 'name' => $meta['name'], 'slug' => $meta['slug']]; if ($meta['type'] === 'tag') { $tags[] = $m; } elseif ($meta['type'] === 'category') { $categories[] = $m; } }
        return ['cid' => $cid, 'parent' => (int) $row['parent'], 'type' => $row['type'], 'status' => $row['status'], 'title' => html_entity_decode($row['title'] ?? '', ENT_QUOTES, 'UTF-8'), 'text' => $markdown ? substr($text, 15) : $text, 'format' => $markdown ? 'markdown' : 'html', 'slug' => ltrim($row['slug'] ?? '', '@'), 'tags' => $tags, 'categories' => $categories, 'fields' => $fields, 'raw' => $row, 'url' => null];
    }
    private function snapshot(int $cid): array
    {
        $row = $this->row($cid); $this->demand($row, 'missing', 404);
        if ($row['type'] === 'post_draft' && (int) $row['parent'] > 0) { $row = $this->row((int) $row['parent']); $this->demand($row, 'missing', 404); }
        $published = $row['type'] === 'post' ? $this->variant($row) : null;
        $draft = $row['type'] === 'post_draft' ? $row : $this->bridgeDb->fetchRow($this->bridgeDb->select()->from('table.contents')->where('parent = ? AND type = ?', $row['cid'], 'post_draft')->limit(1));
        $snapshot = ['published' => $published, 'savedDraft' => $draft ? $this->variant($draft) : null];
        // Theme page views change on reads, not article edits. Preserve raw values
        // in snapshots, but exclude this counter from preview/confirmation versions.
        $versionData = $snapshot;
        unset($versionData['published']['raw']['views'], $versionData['savedDraft']['raw']['views']);
        $snapshot['version'] = hash('sha256', json_encode($versionData, JSON_THROW_ON_ERROR));
        return $snapshot;
    }
    private function receipt(array $input): array
    {
        $id = $input['requestId'] ?? ''; $this->demand(is_string($id) && preg_match('/^[a-f0-9-]{36}$/', $id));
        $row = $this->bridgeDb->fetchRow($this->bridgeDb->select()->from('table.dsh_blog_receipts')->where('request_id = ? AND uid = ?', $id, $this->bridgeUser->uid));
        return $row ? ['status' => 'succeeded', 'result' => json_decode($row['result'], true)] : ['status' => 'unknown'];
    }
    private function saveArticle(array $input): array
    {
        $this->status(); $db = $this->bridgeDb; $content = $input['content'] ?? null; $mode = $input['mode'] ?? '';
        $this->demand(is_array($content) && in_array($mode, ['draft', 'publish'], true));
        foreach (['title' => 300, 'text' => 500000, 'slug' => 200] as $key => $limit) { $this->demand(isset($content[$key]) && is_string($content[$key]) && mb_strlen($content[$key]) <= $limit); }
        $this->demand(in_array($content['format'] ?? '', ['markdown', 'html'], true));
        if ($mode === 'publish') { $this->demand(trim($content['title']) !== '' && trim($content['text']) !== ''); }
        $this->demand(is_array($content['tags'] ?? null) && count($content['tags']) <= 50 && is_array($content['categories'] ?? null) && count($content['categories']) <= 50);
        foreach ($content['tags'] as $tag) { $this->demand(is_string($tag) && mb_strlen($tag) <= 80 && trim($tag) !== '' && strpos($tag, ',') === false); }
        foreach ($content['categories'] as $category) { $this->id($category); $this->demand($db->fetchRow($db->select('mid')->from('table.metas')->where('mid = ? AND type = ?', $category, 'category'))); }
        $this->demand(!isset($content['allowComment']) || is_bool($content['allowComment']));
        $requestId = $input['requestId'] ?? ''; $this->demand(is_string($requestId) && preg_match('/^[a-f0-9-]{36}$/', $requestId));
        $hash = hash('sha256', json_encode([$mode, $content, $input['base'] ?? null], JSON_THROW_ON_ERROR));
        $db->query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', \Typecho\Db::WRITE);
        $db->query('START TRANSACTION', \Typecho\Db::WRITE); $this->transaction = true;
        $receipt = $db->fetchRow($db->select()->from('table.dsh_blog_receipts')->where('request_id = ?', $requestId));
        if ($receipt) {
            $this->demand((int) $receipt['uid'] === (int) $this->bridgeUser->uid && hash_equals($receipt['input_hash'], $hash), 'conflict', 409);
            $db->query('COMMIT', \Typecho\Db::WRITE); $this->transaction = false; return json_decode($receipt['result'], true);
        }
        $base = $input['base'] ?? null; $source = null; $rootCid = null;
        if ($base !== null) {
            $this->demand(is_array($base) && is_string($base['version'] ?? null));
            $rootCid = $this->id($base['published']['cid'] ?? $base['savedDraft']['cid'] ?? null);
            $current = $this->snapshot($rootCid);
            $this->demand(hash_equals($current['version'], $base['version']), 'conflict', 409);
            $selected = $base['selectedVariant'] ?? ($current['savedDraft'] ? 'savedDraft' : 'published');
            $this->demand(in_array($selected, ['published', 'savedDraft'], true) && $current[$selected]); $source = $current[$selected];
            $rootCid = $current['published']['cid'] ?? $current['savedDraft']['cid'];
        }
        $options = \Widget\Options::alloc(); $raw = $source['raw'] ?? [];
        $contents = [
            'title' => $content['title'], 'text' => ($content['format'] === 'markdown' ? '<!--markdown-->' : '') . $content['text'],
            'slug' => $content['slug'], 'tags' => implode(',', $content['tags']), 'category' => $content['categories'],
            'type' => $mode === 'publish' ? 'post' : 'post_draft',
            'created' => (int) ($raw['created'] ?? ($mode === 'publish' ? $options->time : 0)),
            'allowComment' => (int) ($content['allowComment'] ?? $raw['allowComment'] ?? $options->defaultAllowComment),
            'allowPing' => (int) ($raw['allowPing'] ?? $options->defaultAllowPing),
            'allowFeed' => (int) ($raw['allowFeed'] ?? $options->defaultAllowFeed),
            'visibility' => !empty($raw['password']) ? 'password' : ($raw['status'] ?? 'publish'),
            'password' => $raw['password'] ?? '', 'order' => (int) ($raw['order'] ?? 0), 'template' => $raw['template'] ?? null,
        ];
        if ($source) { $contents['authorId'] = (int) $raw['authorId']; }
        if ($mode === 'publish') { $contents['parent'] = 0; }
        $widget = DshBlogBridge_Edit::allocWithAlias($requestId, null, $rootCid ? ['cid' => $rootCid] : []);
        foreach ($source['fields'] ?? [] as $field) {
            $type = $field['type']; $value = $type === 'json' ? json_decode($field['str_value'], true, 512, JSON_THROW_ON_ERROR) : ($field[$type . '_value'] ?? null);
            $widget->preservedFields[$field['name']] = [$type, $value];
        }
        $cid = $widget->commitArticle($contents, $mode === 'publish'); $this->demand($cid > 0, 'incompatible', 503);
        $snapshot = $this->snapshot($cid); $written = $mode === 'publish' ? $snapshot['published'] : $snapshot['savedDraft'];
        $this->demand($written && $written['text'] === $content['text'] && $written['format'] === $content['format'], 'incompatible', 503);
        // Check typed custom-field preservation after native widget processing.
        $normalFields = function ($fields) {
            foreach ($fields as &$f) {
                unset($f['cid']);
                if ($f['type'] === 'json') { $f['str_value'] = json_decode($f['str_value'], true, 512, JSON_THROW_ON_ERROR); }
            }
            return $fields;
        };
        $this->demand($normalFields($written['fields']) === $normalFields($source['fields'] ?? []), 'incompatible', 503);
        $snapshot['selectedVariant'] = $mode === 'publish' ? 'published' : 'savedDraft';
        $result = ['cid' => $cid, 'version' => $snapshot['version'], 'snapshot' => $snapshot, 'url' => $mode === 'publish' ? $widget->permalink : null];
        $db->query($db->insert('table.dsh_blog_receipts')->rows(['request_id' => $requestId, 'uid' => $this->bridgeUser->uid, 'input_hash' => $hash, 'result' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'created_at' => time()]));
        $db->query('COMMIT', \Typecho\Db::WRITE); $this->transaction = false; return $result;
    }
    private function deleteArticle(array $input): array
    {
        $this->status(); $db = $this->bridgeDb;
        $cid = $this->id($input['cid'] ?? null);
        $version = $input['base']['version'] ?? null;
        $this->demand(is_string($version) && preg_match('/^[a-f0-9]{64}$/', $version));
        $requestId = $input['requestId'] ?? '';
        $this->demand(is_string($requestId) && preg_match('/^[a-f0-9-]{36}$/', $requestId));
        $hash = hash('sha256', json_encode(['delete', $cid, $version], JSON_THROW_ON_ERROR));
        $db->query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', \Typecho\Db::WRITE);
        $db->query('START TRANSACTION', \Typecho\Db::WRITE); $this->transaction = true;
        $receipt = $db->fetchRow($db->select()->from('table.dsh_blog_receipts')->where('request_id = ?', $requestId));
        if ($receipt) {
            $this->demand((int) $receipt['uid'] === (int) $this->bridgeUser->uid && hash_equals($receipt['input_hash'], $hash), 'conflict', 409);
            $db->query('COMMIT', \Typecho\Db::WRITE); $this->transaction = false;
            return json_decode($receipt['result'], true);
        }
        $before = $this->snapshot($cid);
        $this->demand(($before['published']['cid'] ?? $before['savedDraft']['cid']) === $cid, 'conflict', 409);
        $this->demand(hash_equals($before['version'], $version), 'conflict', 409);
        $widget = DshBlogBridge_Edit::allocWithAlias($requestId, null, ['cid' => $cid]);
        $deleted = $widget->removeArticle();
        foreach ($deleted as $id) { $this->demand($this->row($id) === null, 'incompatible', 503); }
        $result = ['cid' => $cid, 'deleted' => true, 'deletedCids' => $deleted, 'url' => null, 'snapshot' => null];
        $db->query($db->insert('table.dsh_blog_receipts')->rows(['request_id' => $requestId, 'uid' => $this->bridgeUser->uid, 'input_hash' => $hash, 'result' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'created_at' => time()]));
        $db->query('COMMIT', \Typecho\Db::WRITE); $this->transaction = false;
        return $result;
    }
}
