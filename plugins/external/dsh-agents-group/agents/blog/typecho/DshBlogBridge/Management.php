<?php
/** Native taxonomy/comment operations with frozen previews and transaction receipts. */
trait DshBlogBridge_Management
{
    private function managementKind(array $input): string
    {
        $kind = $input['kind'] ?? '';
        $this->demand(in_array($kind, ['category', 'tag', 'comment'], true));
        return $kind;
    }
    private function managementList(array $input): array
    {
        $kind = $this->managementKind($input); $db = $this->bridgeDb;
        $page = $input['page'] ?? 1; $q = $input['query'] ?? '';
        $this->demand(is_int($page) && $page > 0 && $page <= 10000 && is_string($q) && mb_strlen($q) <= 200);
        $sql = $db->select()->from($kind === 'comment' ? 'table.comments' : 'table.metas');
        if ($kind === 'comment') {
            if (!empty($input['cid'])) { $sql->where('cid = ?', $this->id($input['cid'])); }
            $status = $input['status'] ?? 'all';
            $this->demand(in_array($status, ['all', 'approved', 'waiting', 'spam'], true));
            if ($status !== 'all') { $sql->where('status = ?', $status); }
            if ($q !== '') { $sql->where('LOCATE(?, text) > 0 OR LOCATE(?, author) > 0', $q, $q); }
            $sql->order('coid', \Typecho\Db::SORT_DESC);
        } else {
            $sql->where('type = ?', $kind);
            if ($q !== '') { $sql->where('LOCATE(?, name) > 0 OR LOCATE(?, slug) > 0', $q, $q); }
            $sql->order('mid', \Typecho\Db::SORT_ASC);
        }
        $rows = $db->fetchAll($sql->offset(($page - 1) * 30)->limit(31));
        return ['items' => array_map(function ($r) use ($kind) { return $this->managementPublic($kind, $r); }, array_slice($rows, 0, 30)), 'page' => $page, 'hasMore' => count($rows) > 30];
    }
    private function managementPublic(string $kind, array $row): array
    {
        // Network metadata and internal account identifiers are not needed by editors or models.
        unset($row['ip'], $row['agent'], $row['authorId'], $row['ownerId']);
        $row['id'] = (int) $row[$kind === 'comment' ? 'coid' : 'mid'];
        foreach (['cid','coid','mid','parent','count','created','order'] as $key) {
            if (isset($row[$key])) { $row[$key] = (int) $row[$key]; }
        }
        return $row;
    }
    private function managementGet(array $input): array
    {
        $kind = $this->managementKind($input); $id = $this->id($input['id'] ?? null); $db = $this->bridgeDb;
        $sql = $db->select()->from($kind === 'comment' ? 'table.comments' : 'table.metas')->where(($kind === 'comment' ? 'coid' : 'mid') . ' = ?', $id);
        if ($kind !== 'comment') { $sql->where('type = ?', $kind); }
        $row = $db->fetchRow($sql); $this->demand($row, 'missing', 404);
        $related = $db->fetchAll($db->select($kind === 'comment' ? 'coid' : 'cid')->from($kind === 'comment' ? 'table.comments' : 'table.relationships')->where(($kind === 'comment' ? 'parent' : 'mid') . ' = ?', $id)->order($kind === 'comment' ? 'coid' : 'cid', \Typecho\Db::SORT_ASC));
        $children = $kind === 'category' ? $db->fetchAll($db->select('mid')->from('table.metas')->where('parent = ? AND type = ?', $id, 'category')->order('mid', \Typecho\Db::SORT_ASC)) : [];
        $default = $kind === 'category' ? (int) \Widget\Options::alloc()->defaultCategory : 0;
        return ['item' => $this->managementPublic($kind, $row), 'version' => hash('sha256', json_encode([$row, $related, $children, $default], JSON_THROW_ON_ERROR)),
            'impact' => ['relatedCount' => count($related), 'childCategories' => count($children), 'defaultCategory' => $default === $id]];
    }
    private function managementPreview(array $input): array
    {
        $kind = $this->managementKind($input); $operation = $input['operation'] ?? '';
        $this->demand(in_array($operation, ['create','update','delete'], true));
        $before = $operation === 'create' ? null : $this->managementGet($input);
        if ($before && isset($input['version'])) { $this->demand(is_string($input['version']) && hash_equals($before['version'], $input['version']), 'conflict', 409); }
        $fields = $input['fields'] ?? []; $this->demand(is_array($fields));
        $allowed = $kind === 'comment' ? ['author','text','mail','url','status','cid','parent'] : ['name','slug','description','parent','isDefault'];
        foreach (array_keys($fields) as $key) { $this->demand(in_array($key, $allowed, true)); }
        if ($operation !== 'delete') {
            if ($kind === 'comment') {
                if ($operation === 'update') { $this->demand(!isset($fields['cid']) && !isset($fields['parent'])); }
                $fields = array_merge($operation === 'create' ? ['author' => $this->bridgeUser->screenName, 'text' => '', 'mail' => '', 'url' => '', 'status' => 'waiting', 'parent' => 0] : array_intersect_key($before['item'], array_flip(['author','text','mail','url','status'])), $fields);
                foreach (['author'=>200,'text'=>50000,'mail'=>200,'url'=>200] as $key=>$limit) { $this->demand(is_string($fields[$key]) && mb_strlen($fields[$key]) <= $limit); }
                $this->demand(trim($fields['text']) !== '' && trim($fields['author']) !== '' && strip_tags($fields['author']) === $fields['author']);
                $this->demand($fields['mail'] === '' || filter_var($fields['mail'], FILTER_VALIDATE_EMAIL));
                $this->demand($fields['url'] === '' || (filter_var($fields['url'], FILTER_VALIDATE_URL) && in_array(parse_url($fields['url'], PHP_URL_SCHEME), ['http','https'], true)));
                $this->demand(in_array($fields['status'], ['approved','waiting','spam'], true));
                if ($operation === 'create') {
                    $post = $this->row($this->id($fields['cid'] ?? null)); $this->demand($post && (int) $post['parent'] === 0, 'missing', 404);
                    $this->demand(is_int($fields['parent']) && $fields['parent'] >= 0);
                    if ($fields['parent']) { $parent = $this->managementGet(['kind'=>'comment','id'=>$fields['parent']]); $this->demand($parent['item']['cid'] === $fields['cid']); }
                }
            } else {
                $fields = array_merge($before ? array_intersect_key($before['item'], array_flip(['name','slug','description','parent'])) : ['name'=>'','slug'=>'','description'=>'','parent'=>0], $fields);
                foreach (['name'=>80,'slug'=>200,'description'=>1000] as $key=>$limit) { $this->demand(is_string($fields[$key]) && mb_strlen($fields[$key]) <= $limit && strip_tags($fields[$key]) === $fields[$key]); }
                $fields['name'] = trim($fields['name']); $this->demand($fields['name'] !== '' && strpos($fields['name'], ',') === false);
                $fields['slug'] = \Typecho\Common::slugName($fields['slug'] ?: $fields['name']); $this->demand($fields['slug'] !== '');
                $this->demand(is_int($fields['parent']) && $fields['parent'] >= 0 && ($kind === 'category' || $fields['parent'] === 0));
                $this->demand(!isset($fields['isDefault']) || ($kind === 'category' && is_bool($fields['isDefault'])));
                $seen = []; $parent = $fields['parent'];
                while ($parent) { $this->demand($parent !== ($input['id'] ?? 0) && !isset($seen[$parent])); $seen[$parent]=true; $p=$this->managementGet(['kind'=>'category','id'=>$parent]); $parent=$p['item']['parent']; }
                $sql = $this->bridgeDb->select('mid')->from('table.metas')->where('type = ?', $kind)->where('slug = ? OR (name = ? AND parent = ?)', $fields['slug'], $fields['name'], $fields['parent']);
                if ($before) { $sql->where('mid <> ?', $input['id']); }
                $this->demand(!$this->bridgeDb->fetchRow($sql), 'conflict', 409);
            }
        } else {
            $fields = [];
            // Change the default first, so new articles never point at a deleted category.
            $this->demand(!($before['impact']['defaultCategory'] ?? false), 'default-category', 409);
        }
        $normalized = ['kind'=>$kind,'operation'=>$operation,'fields'=>$fields];
        if ($before) { $normalized['id']=$input['id']; $normalized['version']=$before['version']; }
        return ['input'=>$normalized,'title'=>($fields['name'] ?? $before['item']['name'] ?? ($kind === 'comment' ? '评论 ' . ($input['id'] ?? '新建') : '')),
            'impact'=>array_merge($before['impact'] ?? [], ['note'=>$kind === 'comment' ? '评论操作立即生效；已批准评论对访客可见。删除保留回复并上移一级。' : '名称和描述立即影响关联文章。删除仅解除文章关联，保留文章；子分类移到上一级。'])];
    }
    private function managementWrite(array $input): array
    {
        $this->status(); $db=$this->bridgeDb; $requestId=$input['requestId'] ?? '';
        $this->demand(is_string($requestId) && preg_match('/^[a-f0-9-]{36}$/', $requestId));
        $hash=hash('sha256', json_encode(['manage',$input['kind'] ?? null,$input['operation'] ?? null,$input['id'] ?? null,$input['version'] ?? null,$input['fields'] ?? []], JSON_THROW_ON_ERROR));
        $db->query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', \Typecho\Db::WRITE);
        $db->query('START TRANSACTION', \Typecho\Db::WRITE); $this->transaction=true;
        $receipt=$db->fetchRow($db->select()->from('table.dsh_blog_receipts')->where('request_id = ?', $requestId));
        if ($receipt) {
            $this->demand((int) $receipt['uid'] === (int) $this->bridgeUser->uid && hash_equals($receipt['input_hash'],$hash), 'conflict',409);
            $db->query('COMMIT', \Typecho\Db::WRITE); $this->transaction=false; return json_decode($receipt['result'],true);
        }
        $preview=$this->managementPreview($input); $v=$preview['input']; $kind=$v['kind']; $op=$v['operation']; $id=$v['id'] ?? null; $fields=$v['fields'];
        if ($id) { $this->demand(is_string($input['version'] ?? null) && hash_equals($v['version'],$input['version']), 'conflict',409); }
        if ($kind === 'comment') {
            $widget=\Widget\Base\Comments::allocWithAlias($requestId);
            if ($op === 'create') { $post=$this->row($fields['cid']); $id=$widget->insert($fields+['authorId'=>$this->bridgeUser->uid,'ownerId'=>$post['authorId'],'type'=>'comment']); }
            elseif ($op === 'update') { $widget->update($fields,$db->sql()->where('coid = ?', $id)); }
            else {
                $before=$this->managementGet(['kind'=>$kind,'id'=>$id]);
                $db->query($db->update('table.comments')->rows(['parent'=>$before['item']['parent']])->where('parent = ?', $id));
                $widget->delete($db->sql()->where('coid = ?', $id));
            }
        } else {
            $widget=\Widget\Base\Metas::allocWithAlias($requestId); $isDefault=$fields['isDefault'] ?? false; unset($fields['isDefault']);
            if ($op === 'create') { $id=$widget->insert($fields+['type'=>$kind,'count'=>0,'order'=>0]); }
            elseif ($op === 'update') { $widget->update($fields,$db->sql()->where('mid = ?', $id)); }
            else {
                $before=$this->managementGet(['kind'=>$kind,'id'=>$id]);
                $db->query($db->delete('table.relationships')->where('mid = ?', $id));
                if ($kind === 'category') { $widget->update(['parent'=>$before['item']['parent']],$db->sql()->where('parent = ? AND type = ?', $id,'category')); }
                $widget->delete($db->sql()->where('mid = ?', $id));
            }
            if ($isDefault) { $db->query($db->update('table.options')->rows(['value'=>$id])->where('name = ?', 'defaultCategory')); }
        }
        $result=['id'=>(int)$id,'kind'=>$kind,'deleted'=>$op==='delete'];
        if ($op !== 'delete') { $result['item']=$this->managementGet(['kind'=>$kind,'id'=>(int)$id])['item']; }
        $db->query($db->insert('table.dsh_blog_receipts')->rows(['request_id'=>$requestId,'uid'=>$this->bridgeUser->uid,'input_hash'=>$hash,'result'=>json_encode($result,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),'created_at'=>time()]));
        $db->query('COMMIT', \Typecho\Db::WRITE); $this->transaction=false; return $result;
    }
}
