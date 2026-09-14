"""Validate design data, not game runtime behavior. Requires an explicit plugin root."""
import argparse
import copy
import itertools
import json
import re
from datetime import datetime
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker, SchemaError, ValidationError


class Loader(yaml.SafeLoader):
    pass


# PyYAML otherwise treats the state-transition key `on` as a YAML 1.1 boolean.
Loader.yaml_implicit_resolvers = copy.deepcopy(yaml.SafeLoader.yaml_implicit_resolvers)
for key, rules in Loader.yaml_implicit_resolvers.items():
    Loader.yaml_implicit_resolvers[key] = [(tag, pattern) for tag, pattern in rules
                                         if tag != 'tag:yaml.org,2002:bool']
Loader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(true|false)$'), list('tf'))


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate key: {key}')
        result[key] = value
    return result


def mapping(loader, node):
    return unique_pairs((loader.construct_object(k), loader.construct_object(v))
                        for k, v in node.value)


Loader.add_constructor('tag:yaml.org,2002:map', mapping)
FORMATS = FormatChecker()


@FORMATS.checks('date-time', raises=(ValueError, TypeError))
def date_time(value):
    if not isinstance(value, str):
        return True
    return 'T' in value and datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is not None


def require(condition, message):
    if not condition:
        raise ValueError(message)


def walk(value):
    yield value
    if isinstance(value, dict):
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def sources(edge):
    return edge['from'] if isinstance(edge['from'], list) else [edge['from']]


def reachable(start, edges, destination):
    seen, pending = set(), [start]
    while pending:
        state = pending.pop()
        if state in destination:
            return True
        if state not in seen:
            seen.add(state)
            pending.extend(edge['to'] for edge in edges if state in sources(edge))
    return False


def select_prompt(triggers, facts):
    eligible = [t for t in triggers if all(facts.get(k, False) == v for k, v in t['requires'].items())]
    return max(eligible, key=lambda t: t['priority'])['id'] if eligible else None


def aggregate(protocol, children):
    flags = {'has_failure': any(s in ('failed', 'cancelled') for s in children),
             'has_success': 'succeeded' in children, 'has_external': 'external_pending' in children}
    matches = [row for row in protocol['aggregation']['rows'] if all(row[k] == v for k, v in flags.items())]
    require(len(matches) == 1, 'aggregation must have exactly one matching row')
    return matches[0]['outcome']


def effective_outcomes(protocol, sample):
    """Check a finite plan sample; historical attempts are not current deliverables."""
    require(sample['acceptedVersion'] == sample['processedVersion'], 'unprocessed input cannot finish')
    goals, attempts = sample['currentGoals'], sample['attempts']
    require(len(goals) == len(set(goals)), 'duplicate current goal')
    by_id = {a['subtaskId']: a for a in attempts}
    require(len(by_id) == len(attempts), 'duplicate attempt')
    unmet = {g['logicalId']: g['reason'] for g in sample['unmetGoals']}
    require(len(unmet) == len(sample['unmetGoals']) and set(unmet) <= set(goals) and all(unmet.values()), 'invalid unmet goals')
    replaced = set()
    all_goals = {a['logicalId'] for a in attempts} | set(goals)
    for a in attempts:
        require(a['outcome'] in protocol['subtask']['terminal'], 'nonterminal attempt in final sample')
        require(1 <= a['inputVersion'] <= sample['processedVersion'], 'invalid attempt input version')
        require(set(a['dependsOn']) <= all_goals - {a['logicalId']}, 'unknown/self dependency')
        previous = a.get('supersedes')
        if previous:
            require(previous in by_id and previous not in replaced, 'replacement missing or branched')
            require(by_id[previous]['logicalId'] == a['logicalId'], 'replacement changes logical goal')
            replaced.add(previous)
            seen, cursor = {a['subtaskId']}, previous
            while cursor:
                require(cursor not in seen and cursor in by_id, 'replacement cycle or missing target')
                seen.add(cursor)
                cursor = by_id[cursor].get('supersedes')
        if a.get('retryOf'):
            require(a['retryOf'] == previous and by_id[previous]['outcome'] == 'failed', 'invalid retry source')
        for ref in a.get('inputRefs', []):
            require(ref['subtaskId'] in by_id and bool(ref['resultRef']), 'missing input material')
            source = by_id[ref['subtaskId']]
            require(source['logicalId'] in a['dependsOn'] and source['outcome'] in ('succeeded', 'external_pending'), 'invalid dependency material')
    leaves = {}
    for goal in goals:
        if goal in unmet:
            continue
        candidates = [a for a in attempts if a['logicalId'] == goal and a['subtaskId'] not in replaced]
        require(len(candidates) == 1, 'current goal has no unique effective attempt')
        leaves[goal] = candidates[0]
    visiting, finished = set(), set()

    def visit(goal):
        require(goal not in visiting, 'dependency cycle')
        if goal in finished or goal not in leaves:
            return
        visiting.add(goal)
        for dependency in leaves[goal]['dependsOn']:
            visit(dependency)
        visiting.remove(goal)
        finished.add(goal)

    for goal in leaves:
        visit(goal)
    for a in leaves.values():
        if a['outcome'] not in ('succeeded', 'external_pending'):
            continue
        refs = {r['subtaskId'] for r in a.get('inputRefs', [])}
        for dependency in a['dependsOn']:
            require(dependency in leaves and leaves[dependency]['outcome'] in ('succeeded', 'external_pending'), 'successful step has unfinished dependency')
            require(leaves[dependency]['subtaskId'] in refs, 'successful step uses missing/stale dependency material')
    return [a['outcome'] for a in leaves.values()] + ['failed'] * len(unmet)


def dependency_action(protocol, facts):
    keys = ('upstream', 'materialsReady', 'requiresExternalAction')
    rows = [r for r in protocol['scheduling']['ready_rules'] if all(r[k] == facts[k] for k in keys)]
    require(len(rows) <= 1, 'overlapping dependency rules')
    return rows[0]['action'] if rows else protocol['scheduling']['default_action']


def npc_movement_allowed(npcs, world, case):
    """Cases may assume enabled portals; topology still comes from the current world."""
    profile = npcs['profiles'][case['profile']]
    if case['from_map'] not in case['allowed_maps'] or case['to_map'] not in case['allowed_maps']:
        return False
    if case['from_map'] != case['to_map']:
        route = (case['from_map'], case['to_map'])
        connected = any(route == (c['from']['map_id'], c['to']['map_id']) or
                        (c['bidirectional'] and route == (c['to']['map_id'], c['from']['map_id']))
                        for c in world['connections'])
        return profile['cross_map'] and case['connection_enabled'] and connected
    return not profile['fixed_origin_required'] or set(case['path']) <= set(case['allowed_cells'])


def validate(docs):
    rules, events, cases = (docs[n] for n in ('rules_schema.json', 'event_schema.json', '验收场景.json'))
    Draft202012Validator.check_schema(rules)
    Draft202012Validator.check_schema(events)
    for name, target in rules['$defs']['targets'].items():
        schema = {'$defs': rules['$defs'], **target}
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema, format_checker=FORMATS).validate(docs[name])

    references = 0
    for value in walk(docs):
        if isinstance(value, str):
            for file, path in re.findall(r'([a-z_]+\.(?:yaml|json))#([\w.]+)', value):
                require(file in docs, f'unknown reference file: {file}')
                target = docs[file]
                for part in path.rstrip('.').split('.'):
                    require(isinstance(target, dict) and part in target, f'broken reference: {file}#{path}')
                    target = target[part]
                references += 1

    fsm, protocol = docs['agent_fsm.yaml'], docs['task_protocol.yaml']
    graphs, region_count = {}, 0
    for who, machine in fsm['machines'].items():
        require(machine['kind'] == 'parallel', f'{who} must have parallel regions')
        for region, definition in machine['regions'].items():
            name = f'{who}.{region}'
            states, rest = definition['states'], definition['rest_states']
            edges = [dict(edge, **{'from': state}) for state, spec in states.items() for edge in spec['exits']]
            require(definition['initial'] in states and set(rest) <= states.keys(), f'{name}: invalid initial/rest')
            for edge in edges:
                require(edge['to'] in states, f'{name}: unknown target {edge["to"]}')
            for state, spec in states.items():
                require(reachable(state, edges, set(rest)), f'{name}.{state}: rest unreachable')
                require(reachable(definition['initial'], edges, {state}), f'{name}.{state}: unreachable from initial')
                if state not in rest:
                    require(any(re.search(r'cancel|timeout|fail|\.terminal$', edge['on']) for edge in spec['exits']),
                            f'{name}.{state}: missing abnormal/terminal exit')
            graphs[name] = edges
            region_count += 1
    for name in ('task', 'subtask'):
        definition = protocol[name]
        states, terminals, edges = definition['states'], set(definition['terminal']), definition['transitions']
        require(definition['initial'] in states and terminals <= states.keys(), f'{name}: unknown state')
        for edge in edges:
            require(edge['to'] in states and set(sources(edge)) <= states.keys(), f'{name}: broken transition')
            require(not terminals.intersection(sources(edge)), f'{name}: terminal is mutable')
            if name == 'task' and edge['to'] in terminals:
                require(edge['on'] in ('all_subtasks_terminal_and_reply_done', 'cleanup_done'), 'task bypasses child cleanup')
        for state in states:
            require(reachable(state, edges, terminals), f'{name}.{state}: terminal unreachable')
        graphs[name] = edges
    for document in (fsm, protocol):
        for value in walk(document):
            if isinstance(value, dict):
                require(not {'mission', 'job'}.intersection(value), 'noncanonical business identifier')
                require(not any('牛马' in str(key) for key in value), 'noncanonical identifier')
    for event in ('result.ok', 'result.external_pending', 'result.error', 'result.cancelled', 'needs_user_input'):
        require(any(e['on'] == event and 'dispatched' in sources(e) for e in graphs['subtask']), f'missing no-progress return: {event}')
    require(all(e['to'] != 'planned' for e in graphs['subtask']), 'ownership can roll back')
    for state, spec in fsm['machines']['staff']['regions']['work']['states'].items():
        if state != 'free':
            require(any(e['on'] == 'subtask.terminal' and e['to'] == 'free' for e in spec['exits']), 'work waits for animation')
        require(not any(e['on'] == 'timeout' for e in spec['exits']), 'local timer changes work status')
    claims = {r['id'] for r in protocol['claim']['rules']}
    require({'one-subtask-per-staff', 'validate-before-dispatch', 'execution-isolation'} <= claims, 'missing ownership rules')
    require(protocol['result_mapping']['waiting_user']['blog'] == 'result.external_pending', 'blog waiting becomes success')
    rows = protocol['aggregation']['rows']
    flags = [(r['has_failure'], r['has_success'], r['has_external']) for r in rows]
    require(set(flags) == set(itertools.product([False, True], repeat=3)) and len(flags) == 8, 'aggregation has gaps/overlaps')

    butler = fsm['machines']['butler']
    duties = butler['regions']['duty']['states']
    require(set(butler['allowed_locomotion']) == set(duties), 'missing butler duty compatibility')
    for duty, positions in butler['allowed_locomotion'].items():
        require(set(positions) <= butler['regions']['locomotion']['states'].keys(), 'unknown butler position')
        if duty not in ('idle', 'listening'):
            require(set(positions) <= {'at_post', 'returning'}, 'busy butler can roam')
    for state in ('roaming', 'returning'):
        engaged = [e for e in butler['regions']['locomotion']['states'][state]['exits'] if e['on'] == 'boss_engaged']
        require(all(e.get('guard') == 'duty.listening' for e in engaged), 'busy butler can enter standing')

    interaction, balance, world = (docs[n] for n in ('interaction_rules.yaml', 'balance_params.yaml', 'map_rules.yaml'))
    triggers = interaction['triggers']
    ids = [t['id'] for t in triggers]
    require(len(set(ids)) == len(ids) and len({t['priority'] for t in triggers}) == len(ids), 'duplicate trigger id/priority')
    for t in triggers:
        require(set(t['suppress']) <= set(ids) - {t['id']}, 'unknown/self suppression')
        require(set(t['requires']) <= {'input_open', 'input_focused', 'dialogue_open', 'map_loading', 'task_running', 'task_stopping',
                'butler_near', 'butler_idle', 'staff_near', 'staff_can_talk', 'staff_reply_pending',
                'npc_near', 'npc_can_talk', 'portal_near', 'poi_near'}, 'unknown prompt fact')
    for conflict in interaction['conflicts']:
        require(bool(conflict['resolution'].strip()), 'conflict lacks resolution')
    require(balance['interaction']['walk_away_tiles'] > balance['interaction']['interact_radius_tiles'], 'missing hysteresis')
    require(balance['subtask']['max_concurrent'] <= balance['concurrency']['staff_count'] == 3, 'bad concurrency')
    require(balance['autonomous']['min_idle_ms'] <= balance['autonomous']['max_idle_ms'], 'idle range reversed')
    require(balance['butler_timeouts']['standing_max_ms'] == balance['butler_timeouts']['listening_ms'], 'input/standing timeout mismatch')
    require(balance['text']['bubble_min_ms'] <= balance['text']['bubble_default_ms'] <= balance['text']['bubble_max_ms'], 'bubble interval invalid')
    for name, key in [('POST /niuma/message', 'message'), ('POST /niuma/reply', 'text')]:
        require(events['x-requests'][name]['properties'][key]['maxLength'] == balance['text']['max_message_chars'], 'request limit drift')
    maps = {m['id']: m for m in world['maps']}
    buildings = {b['id']: b for b in world['buildings']}
    require(len(maps) == len(world['maps']) and len(buildings) == len(world['buildings']), 'duplicate map/building')
    require('street' in maps and maps['street'].get('kind') == 'outdoor' and maps['street'].get('building_id') is None,
            'street must be an outdoor map without a building')
    require({r['id'] for r in maps['street']['regions']} == {'office_frontage', 'cafe_frontage', 'street_walkway', 'commercial_frontage'},
            'street must contain the four defined frontage and walkway regions')
    for b in buildings.values():
        require(set(b['maps']) <= maps.keys() and all(maps[m].get('building_id') == b['id'] for m in b['maps']), 'building/map mismatch')
    for m in maps.values():
        local = {r['id'] for r in m['regions']}
        require(len(local) == len(m['regions']), 'duplicate region')
        require(all(a['from'] in local and a['to'] in local for a in m['adjacency']), 'unknown map adjacency')
        bidirectional = [e for a in m['adjacency'] for e in ({'from': a['from'], 'to': a['to']}, {'from': a['to'], 'to': a['from']})]
        require(all(reachable(next(iter(local)), bidirectional, {r}) for r in local), 'disconnected map regions')
        require(len({e['id'] for e in m['entries']}) == len(m['entries']) and all(e['region'] in local for e in m['entries']), 'invalid map entry')
        if m.get('building_id') is not None:
            require(m['building_id'] in buildings and m['id'] in buildings[m['building_id']]['maps'], 'unknown map building')

    def valid_placement(location):
        return location['map_id'] in maps and location['region'] in {r['id'] for r in maps[location['map_id']]['regions']}

    office = maps['office']
    require({r['id'] for r in office['regions']} == {'boss_office', 'dev', 'meeting', 'restroom', 'hr', 'admin', 'reception', 'commons', 'corridor'},
            'office must contain the nine renovation regions')
    office_entry = next((e for e in office['entries'] if e['id'] == 'office_to_street'), None)
    require(office_entry is not None and office_entry['region'] == 'reception', 'office entrance must belong to reception')
    special_seats = {'example': 'dev_01', 'closedoff': 'dev_02', 'blog': 'dev_03'}
    expected_seats = {f'dev_{i:02}': ('dev', {1: 'example', 2: 'closedoff', 3: 'blog'}.get(i)) for i in range(1, 10)}
    expected_seats.update(hr_01=('hr', 'npc_hr'), hr_02=('hr', 'npc_recruiter'),
                          admin_01=('admin', 'npc_admin'), reception_01=('reception', 'npc_reception'))
    seats = {seat['id']: seat for seat in office['workstations']}
    require(len(seats) == len(office['workstations']) and
            {key: (seat['region'], seat['occupant']) for key, seat in seats.items()} == expected_seats,
            'office workstation count, vacancy or occupant binding is incorrect')
    require(all(valid_placement(p) for p in world['posts'] + world['poi']['items']), 'unknown post/POI map or region')
    core_actors = {'boss', 'butler', 'example', 'closedoff', 'blog'}
    require(len(world['posts']) == 5 and {p['occupant'] for p in world['posts']} == core_actors, 'core posts must exclude ordinary NPCs')
    for post in world['posts']:
        if post['occupant'] in special_seats:
            require(post['map_id'] == 'office' and post['region'] == 'dev' and post.get('workstation_id') == special_seats[post['occupant']],
                    'special NPC must keep its assigned development workstation')
    connections = {c['id']: c for c in world['connections']}
    require(len(connections) == len(world['connections']), 'duplicate connection')
    for c in world['connections']:
        for endpoint in (c['from'], c['to']):
            require(endpoint['map_id'] in maps and endpoint['entry_id'] in {e['id'] for e in maps[endpoint['map_id']]['entries']}, 'broken connection endpoint')
    for connection_id, interior in (('office_street', 'office'), ('cafe_street', 'cafe')):
        c = connections.get(connection_id)
        expected = {(interior, f'{interior}_to_street'), ('street', f'street_to_{interior}')}
        require(c is not None and {(c[side]['map_id'], c[side]['entry_id']) for side in ('from', 'to')} == expected,
                f'missing or incorrect street connection: {connection_id}')
        require(c['bidirectional'] and c['readiness'] in ('pending_layout', 'disabled'), 'street connection must remain bidirectional and inactive')
    require(not any({c['from']['map_id'], c['to']['map_id']} == {'office', 'cafe'} for c in connections.values()),
            'office and cafe must connect through street')
    transition = world['map_transition']
    require(transition['staff_activity_maps'] == ['office'], 'staff activity must remain in office')
    graphs['map'] = transition['transitions']
    for edge in graphs['map']:
        require(set(sources(edge)) <= set(transition['states']) and edge['to'] in transition['states'], 'invalid map transition')
    npcs = docs['npc_rules.yaml']
    ordinary_npcs = npcs['roster'] + npcs['examples']
    npc_ids = [n['id'] for n in ordinary_npcs]
    require(len(npc_ids) == len(set(npc_ids)) and not set(npc_ids).intersection(core_actors), 'NPC identity collision')
    require({n['id'] for n in npcs['roster']} == {'npc_hr', 'npc_recruiter', 'npc_admin', 'npc_reception'}, 'ordinary office roster must contain the four approved characters')
    require({n['id'] for n in npcs['examples']} == {'sample_cafe_keeper', 'sample_explorer'} and
            all(n['status'] == 'design_example' for n in npcs['examples']), 'existing NPC examples must remain examples')
    workplace_ids = [n['workplace']['post_id'] for n in npcs['roster']]
    require(len(set(workplace_ids)) == 4 and not set(workplace_ids).intersection(p['id'] for p in world['posts']), 'ordinary NPC workplace collides with a core post')
    for npc in ordinary_npcs:
        require(valid_placement(npc['initial_placement']), 'NPC initial placement invalid')
        require(set(npc['allowed_maps']) <= maps.keys() and npc['initial_placement']['map_id'] in npc['allowed_maps'], 'NPC map scope invalid')
        if npc['profile'] == 'local':
            require(valid_placement(npc['duty_origin']) and valid_placement(npc['activity_region']), 'NPC duty area invalid')
            require(npc['duty_origin']['map_id'] == npc['activity_region']['map_id'] == npc['initial_placement']['map_id'], 'local NPC crosses map')
            require(npc['allowed_maps'] == [npc['duty_origin']['map_id']], 'local NPC permits outside maps')
        if npc['id'] == 'sample_explorer':
            require(set(npc['allowed_maps']) == {'office', 'street', 'cafe'}, 'explorer example must permit all three maps')
        if npc['status'] == 'confirmed':
            seat = seats.get(npc['workplace']['workstation_id'])
            require(npc['workplace']['post_id'] == f'{npc["id"]}_post' and seat is not None and seat['occupant'] == npc['id'], 'ordinary NPC workplace binding is invalid')
            require(npc['allowed_maps'] == ['office'] and all(npc[key] == {'map_id': 'office', 'region': seat['region']}
                    for key in ('initial_placement', 'duty_origin', 'activity_region')), 'ordinary NPC must remain near its office workplace')
    graphs['npc'] = npcs['fsm']['transitions']
    for edge in graphs['npc']:
        require(set(sources(edge)) <= set(npcs['fsm']['states']) and edge['to'] in npcs['fsm']['states'], 'invalid NPC transition')
    for state in npcs['fsm']['states']:
        require(reachable(state, graphs['npc'], {'unloaded', 'idle'}), 'NPC cannot recover')
        require(reachable(npcs['fsm']['initial'], graphs['npc'], {state}), 'unreachable NPC state')
    kinds = set(events['$defs']['rendezvousKind']['enum'])
    require(kinds == {k['id'] for k in world['anchors']['kinds']} == {k['id'] for k in interaction['rendezvous']['kinds']}, 'rendezvous drift')

    event_types = set()
    for value in events['$defs'].values():
        if isinstance(value, dict) and 'allOf' in value:
            for part in value['allOf']:
                type_spec = part.get('properties', {}).get('type', {})
                event_types.update(type_spec.get('enum', [type_spec['const']] if 'const' in type_spec else []))
    require(set(protocol['events_out']['emitted']) == event_types, 'event output/schema mismatch')
    require(set(events['$defs']['taskOutcome']['enum']) == set(protocol['task']['terminal']), 'task outcomes drift')
    require(set(events['$defs']['subtaskOutcome']['enum']) == set(protocol['subtask']['terminal']), 'subtask outcomes drift')
    require(set(events['$defs']['failureReason']['enum']) == {x['reason'] for x in protocol['failure_taxonomy']}, 'failure taxonomy drift')
    for entity in ('task', 'subtask'):
        require(set(fsm['event_projection'][f'{entity}.terminal']) == {f'{entity}.{state}' for state in protocol[entity]['terminal']}, 'terminal projection drift')

    for case in cases['paths']:
        current = case['start']
        for on, target in case['steps']:
            require(any(e['on'] == on and current in sources(e) and e['to'] == target for e in graphs[case['machine']]), f'path: {case["name"]}')
            current = target
    for case in cases['aggregation']:
        require(aggregate(protocol, case['children']) == case['expected'], f'aggregation: {case["name"]}')
    logical_examples = [v for v in protocol['examples'].values() if isinstance(v, dict) and 'attempts' in v]
    for case in logical_examples + cases['logical_goals']:
        require(aggregate(protocol, effective_outcomes(protocol, case)) == case['expected'], 'effective goal outcome mismatch')
        require(len(case['attempts']) <= balance['subtask']['max_per_task'], 'example exceeds attempt limit')
    for case in cases['invalid_logical_goals']:
        try:
            effective_outcomes(protocol, case)
        except ValueError:
            pass
        else:
            raise ValueError('invalid plan accepted')
    for case in cases['dependency_rules']:
        require(dependency_action(protocol, case['facts']) == case['expected'], 'dependency readiness mismatch')
    for case in cases['npc_movement']:
        require(npc_movement_allowed(npcs, world, case) == case['expected'], f'NPC boundary mismatch: {case["name"]}')
    for case in cases['prompts']:
        require(select_prompt(triggers, case['facts']) == case['expected'], f'prompt: {case["name"]}')
    validator = Draft202012Validator(events, format_checker=FORMATS)
    require({e['type'] for e in cases['events']} == event_types, 'missing event example')
    for event in cases['events']:
        validator.validate(event)
    for event in cases['invalid_events']:
        require(not validator.is_valid(event), 'invalid event accepted')
    for request in cases['requests']:
        schema = {'$defs': events['$defs'], **events['x-requests'][request['route']]}
        Draft202012Validator(schema, format_checker=FORMATS).validate(request['body'])
    for request in cases['invalid_requests']:
        schema = {'$defs': events['$defs'], **events['x-requests'][request['route']]}
        require(not Draft202012Validator(schema, format_checker=FORMATS).is_valid(request['body']), 'invalid request accepted')
    return {'regions': region_count, 'references': references, 'event_types': len(event_types),
            'paths': len(cases['paths']), 'aggregation': len(cases['aggregation']), 'prompts': len(cases['prompts']),
            'valid_events': len(cases['events']), 'invalid_events': len(cases['invalid_events']),
            'requests': len(cases['requests']), 'invalid_requests': len(cases['invalid_requests']),
            'logical_goals': len(logical_examples) + len(cases['logical_goals']), 'invalid_plans': len(cases['invalid_logical_goals']),
            'dependency_cases': len(cases['dependency_rules']), 'maps': len(maps), 'buildings': len(buildings), 'connections': len(connections),
            'npc_roster': len(npcs['roster']), 'npc_examples': len(npcs['examples']), 'characters': len(core_actors) + len(npc_ids),
            'office_workstations': len(seats), 'npc_boundaries': len(cases['npc_movement'])}


def self_test(docs):
    def remove_commercial_region(d):
        street = next(m for m in d['map_rules.yaml']['maps'] if m['id'] == 'street')
        street['regions'] = [r for r in street['regions'] if r['id'] != 'commercial_frontage']
        street['adjacency'] = [a for a in street['adjacency'] if 'commercial_frontage' not in (a['from'], a['to'])]

    mutations = [
        ('schema annotation', lambda d: d['event_schema.json']['$defs'].update(bad={'properties': {'x': 'not a schema'}})),
        ('duplicate priority', lambda d: d['interaction_rules.yaml']['triggers'][1].update(priority=100)),
        ('broken reference', lambda d: d['task_protocol.yaml']['retry'].update(max_attempts='balance_params.yaml#missing')),
        ('busy butler roaming', lambda d: d['agent_fsm.yaml']['machines']['butler']['allowed_locomotion'].update(awaiting=['roaming'])),
        ('missing direct success', lambda d: d['task_protocol.yaml']['subtask']['transitions'].__setitem__(2, {'on': 'result.ok', 'from': 'executing', 'to': 'succeeded'})),
        ('unsafe cancel', lambda d: d['task_protocol.yaml']['task']['transitions'][5].update(to='cancelled')),
        ('false publication', lambda d: d['task_protocol.yaml']['result_mapping']['waiting_user'].update(blog='result.ok')),
        ('NPC fixed origin', lambda d: d['npc_rules.yaml']['profiles']['explorer'].update(fixed_origin_required=True)),
        ('missing map entry', lambda d: d['map_rules.yaml']['connections'][0]['to'].update(entry_id='missing')),
        ('direct office cafe connection', lambda d: d['map_rules.yaml']['connections'].append({
            'id': 'forbidden_direct', 'from': {'map_id': 'office', 'entry_id': 'office_to_street'},
            'to': {'map_id': 'cafe', 'entry_id': 'cafe_to_street'}, 'bidirectional': True, 'readiness': 'pending_layout'})),
        ('one way street connection', lambda d: d['map_rules.yaml']['connections'][0].update(bidirectional=False)),
        ('explorer missing street', lambda d: next(n for n in d['npc_rules.yaml']['examples'] if n['id'] == 'sample_explorer').update(allowed_maps=['office', 'cafe'])),
        ('street marked indoor', lambda d: next(m for m in d['map_rules.yaml']['maps'] if m['id'] == 'street').update(kind='indoor')),
        ('street missing commercial region', remove_commercial_region),
        ('special NPC moved out of development', lambda d: next(p for p in d['map_rules.yaml']['posts'] if p['occupant'] == 'blog').update(region='hr')),
        ('missing development seat', lambda d: next(m for m in d['map_rules.yaml']['maps'] if m['id'] == 'office')['workstations'].pop(8)),
        ('ordinary NPC in core posts', lambda d: d['map_rules.yaml']['posts'].append({'id': 'npc_hr_post', 'map_id': 'office', 'region': 'hr', 'occupant': 'npc_hr'})),
        ('ordinary NPC uses another seat', lambda d: d['npc_rules.yaml']['roster'][0]['workplace'].update(workstation_id='hr_02')),
        ('ordinary NPC enables model chat', lambda d: d['npc_rules.yaml']['roster'][0].update(dialogue_mode='model_chat')),
        ('sample becomes formal roster', lambda d: d['npc_rules.yaml']['examples'][0].update(status='confirmed')),
    ]
    for name, mutate in mutations:
        broken = copy.deepcopy(docs)
        mutate(broken)
        try:
            validate(broken)
        except (ValueError, SchemaError, ValidationError):
            pass
        else:
            raise ValueError(f'self-test failed to reject: {name}')
    require(yaml.load('on: event\nready: true\n', Loader=Loader) == {'on': 'event', 'ready': True}, 'YAML on key corrupted')
    return len(mutations) + 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Explicit dsh-niuma-boss plugin directory')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    folder = args.root.resolve(strict=True) / 'docs' / '02-产品设计' / '02-机制'
    docs = {p.name: yaml.load(p.read_text(encoding='utf-8'), Loader=Loader) if p.suffix == '.yaml'
            else json.loads(p.read_text(encoding='utf-8'), object_pairs_hook=unique_pairs)
            for p in folder.iterdir() if p.suffix in ('.yaml', '.json')}
    result = validate(docs)
    if args.self_test:
        result['self_tests'] = self_test(docs)
    print(json.dumps({'status': 'passed', 'scope': 'design data only', **result}, ensure_ascii=False))


if __name__ == '__main__':
    main()
