<?php
/** Management behaviour against in-memory DB/native-widget doubles, no production writes. */
namespace Typecho { class Common { public static function slugName($s) { return trim(str_replace(' ', '-', $s)); } } }
namespace Widget { class Options { public $defaultCategory=1; public static function alloc() { $v=new self; foreach (\Typecho\Db::$fixture->tables['table.options']??[] as $r) if($r['name']==='defaultCategory')$v->defaultCategory=$r['value']; return $v; } } }
namespace Widget\Base {
    class Metas {
        public $db;
        public static function allocWithAlias($id){$v=new static;$v->db=\Typecho\Db::$fixture;return $v;}
        public function insert($v){$this->db->native[]=['insert',static::class];return $this->db->query($this->db->insert('table.metas')->rows($v));}
        public function update($v,$q){$this->db->native[]=['update',static::class];$q->kind='update';return $this->db->query($q->from('table.metas')->rows($v));}
        public function delete($q){$this->db->native[]=['delete',static::class];$q->kind='delete';return $this->db->query($q->from('table.metas'));}
    }
    class Comments extends Metas {
        public function recount($cid){$count=count(array_filter($this->db->tables['table.comments'],fn($r)=>$r['cid']===$cid&&$r['status']==='approved'));$this->db->query($this->db->update('table.contents')->rows(['commentsNum'=>$count])->where('cid = ?', $cid));}
        public function insert($v){$this->db->native[]=['insert',static::class];$id=$this->db->query($this->db->insert('table.comments')->rows($v+['created'=>100,'ip'=>'private','agent'=>'private']));$this->recount($v['cid']);return $id;}
        public function update($v,$q){$this->db->native[]=['update',static::class];$q->from('table.comments');$cid=$this->db->fetchRow($q)['cid'];$q->kind='update';$this->db->query($q->rows($v));$this->recount($cid);}
        public function delete($q){$this->db->native[]=['delete',static::class];$q->from('table.comments');$cid=$this->db->fetchRow($q)['cid'];$q->kind='delete';$this->db->query($q);$this->recount($cid);}
    }
}
namespace {
    require __DIR__.'/bridge.test.php';
    class ManagementQuery extends QueryDouble {
        public function matches($row){foreach($this->conditions as [$sql,$values]){
            if($sql==='slug = ? OR (name = ? AND parent = ?)') {if(!($row['slug']===$values[0]||($row['name']===$values[1]&&$row['parent']===$values[2])))return false;}
            else {$q=new QueryDouble('select');$q->conditions=[[$sql,$values]];if(!$q->matches($row))return false;}
        }return true;}
    }
    class ManagementDb extends \Typecho\Db {
        public $native=[];
        public function select(...$columns){return new ManagementQuery('select');}
        public function update($table){return(new ManagementQuery('update'))->from($table);}
        public function query($q,$mode=null){
            if(!is_string($q)&&$q->kind==='update'){$count=0;foreach($this->tables[$q->table] as &$row)if($q->matches($row)){$row=array_merge($row,$q->values);$count++;}return $count;}
            if(!is_string($q)&&$q->kind==='insert'&&in_array($q->table,['table.metas','table.comments'])){
                $key=$q->table==='table.metas'?'mid':'coid';$id=max(array_merge([0],array_column($this->tables[$q->table]??[],$key)))+1;$q->values[$key]=$id;parent::query($q,$mode);return $id;
            }
            return parent::query($q,$mode);
        }
    }
    $db=new ManagementDb;\Typecho\Db::$fixture=$db;
    $db->tables=['table.metas'=>[['mid'=>1,'name'=>'默认','slug'=>'default','description'=>'','type'=>'category','parent'=>0,'count'=>0]],'table.contents'=>[['cid'=>10,'parent'=>0,'type'=>'post','status'=>'publish','authorId'=>1,'commentsNum'=>0],['cid'=>20,'parent'=>0,'type'=>'post','status'=>'publish','authorId'=>1,'commentsNum'=>0]],'table.comments'=>[],'table.relationships'=>[],'table.dsh_blog_receipts'=>[],'table.options'=>[['name'=>'defaultCategory','value'=>1]]];
    $ref=new \ReflectionClass('DshBlogBridge_Action');$action=$ref->newInstanceWithoutConstructor();$ref->getProperty('bridgeDb')->setValue($action,$db);$ref->getProperty('bridgeUser')->setValue($action,(object)['uid'=>1,'screenName'=>'作者']);
    $invoke=function($name,$args)use($ref,$action,$db){try{return $ref->getMethod($name)->invoke($action,$args);}catch(\Throwable $e){if($db->backup!==null){$db->query('ROLLBACK');$ref->getProperty('transaction')->setValue($action,false);}throw $e;}};
    $seq=0;$preview=fn($v)=>$invoke('managementPreview',$v);
    $write=function($v)use(&$seq,$invoke){return $invoke('managementWrite',$v+['requestId'=>sprintf('00000000-0000-4000-8000-%012d',++$seq)]);};
    $get=fn($kind,$id)=>$invoke('managementGet',['kind'=>$kind,'id'=>$id]);
    $change=fn($v)=>$write($preview($v)['input']);
    $category=$change(['kind'=>'category','operation'=>'create','fields'=>['name'=>'技术']]);$cat=$category['id'];
    $tag=$change(['kind'=>'tag','operation'=>'create','fields'=>['name'=>'Java']]);
    $child=$change(['kind'=>'category','operation'=>'create','fields'=>['name'=>'子分类','parent'=>$cat]]);
    $db->tables['table.relationships']=[['mid'=>$cat,'cid'=>10],['mid'=>$tag['id'],'cid'=>20]];
    check($get('category',$cat)['impact']['relatedCount']===1,'taxonomy preview counts article relationships');
    rejects($preview,['kind'=>'category','operation'=>'update','id'=>$cat,'fields'=>['parent'=>$child['id']]],400);
    rejects($preview,['kind'=>'category','operation'=>'delete','id'=>1],409);
    $frozen=$preview(['kind'=>'tag','operation'=>'delete','id'=>$tag['id']])['input'];$db->tables['table.relationships'][]=['mid'=>$tag['id'],'cid'=>10];rejects($write,$frozen,409);
    $change(['kind'=>'category','operation'=>'delete','id'=>$cat]);
    check(count($db->tables['table.contents'])===2,'deleting category keeps articles');check($get('category',$child['id'])['item']['parent']===0,'subcategories move to parent');
    $change(['kind'=>'tag','operation'=>'update','id'=>$tag['id'],'fields'=>['name'=>'JVM']]);check($get('tag',$tag['id'])['item']['name']==='JVM','tag update');
    $change(['kind'=>'tag','operation'=>'delete','id'=>$tag['id']]);check($db->tables['table.relationships']===[],'deleting taxonomy clears only relationships');
    $change(['kind'=>'category','operation'=>'update','id'=>$child['id'],'fields'=>['isDefault'=>true]]);$change(['kind'=>'category','operation'=>'delete','id'=>1]);
    $comment=$change(['kind'=>'comment','operation'=>'create','fields'=>['cid'=>10,'text'=>'first','status'=>'approved']]);$coid=$comment['id'];check($db->tables['table.contents'][0]['commentsNum']===1,'native insert updates approved count');
    check(!isset($get('comment',$coid)['item']['ip']),'network metadata is not returned');
    $reply=$change(['kind'=>'comment','operation'=>'create','fields'=>['cid'=>10,'parent'=>$coid,'text'=>'reply']]);
    rejects($preview,['kind'=>'comment','operation'=>'create','fields'=>['cid'=>20,'parent'=>$coid,'text'=>'wrong article']],400);
    rejects($preview,['kind'=>'comment','operation'=>'update','id'=>$coid,'fields'=>['cid'=>20]],400);
    $change(['kind'=>'comment','operation'=>'update','id'=>$coid,'fields'=>['status'=>'spam','text'=>'revised']]);check($db->tables['table.contents'][0]['commentsNum']===0,'native moderation recount');
    $change(['kind'=>'comment','operation'=>'delete','id'=>$coid]);check($get('comment',$reply['id'])['item']['parent']===0,'deleting comment preserves and reparents replies');
    $prepared=$preview(['kind'=>'comment','operation'=>'create','fields'=>['cid'=>10,'text'=>'idempotent']])['input']+['requestId'=>'10000000-0000-4000-8000-000000000001'];
    $first=$invoke('managementWrite',$prepared);$again=$invoke('managementWrite',$prepared);check($first===$again&&count($db->tables['table.comments'])===2,'creation retry returns same receipt');
    rejects(fn($v)=>$invoke('managementWrite',$v),array_replace($prepared,['fields'=>['cid'=>10,'text'=>'different']]),409);
    $db->failReceipt=true;$before=$db->tables;rejects($change,['kind'=>'comment','operation'=>'delete','id'=>$reply['id']],0);check($db->tables===$before,'failed receipt rolls back native delete and replies');
    check(count($invoke('managementList',['kind'=>'comment','cid'=>10,'status'=>'waiting'])['items'])===2,'comment listing filters native status and cid');
    echo "PASS: taxonomy/comment CRUD, graph guards, native calls/counts, impact conflicts, private metadata, receipts and rollback (DB/widget doubles)\n";
}
