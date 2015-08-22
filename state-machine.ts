/*

  Javascript State Machine Library - https://github.com/jakesgordon/javascript-state-machine

  Copyright (c) 2012, 2013, 2014, 2015, Jake Gordon and contributors
  Released under the MIT license - https://github.com/jakesgordon/javascript-state-machine/blob/master/LICENSE

*/

module StateMachine {

  //---------------------------------------------------------------------------

  export var VERSION = "2.3.5";

  //---------------------------------------------------------------------------

  export var Result = {
    SUCCEEDED:    1, // the event transitioned successfully from one state to another
    NOTRANSITION: 2, // the event was successfull but no state transition was necessary
    CANCELLED:    3, // the event was cancelled by the caller in a beforeEvent callback
    PENDING:      4  // the event is asynchronous and the caller is in control of when the transition occurs
  };

  export var Error = {
    INVALID_TRANSITION: 100, // caller tried to fire an event that was innapropriate in the current state
    PENDING_TRANSITION: 200, // caller tried to fire an event while an async transition was still pending
    INVALID_CALLBACK:   300 // caller provided callback function threw an exception
  };

  export var WILDCARD = '*';
  export var ASYNC = 'async';

  //---------------------------------------------------------------------------

  export function create(cfg: any, target) {

    var initial: any = (typeof cfg.initial == 'string') ? { state: cfg.initial } : cfg.initial; // allow for a simple string, or an object with { state: 'foo', event: 'setup', defer: true|false }
    var terminal     = cfg.terminal || cfg['final'];
    var fsm          = target || cfg.target  || {};
    var events       = cfg.events || [];
    var callbacks    = cfg.callbacks || {};
    var map: any     = {}; // track state transitions allowed for an event { event: { from: [ to ] } }
    var transitions  = {}; // track events allowed from a state            { state: [ event ] }

    var add = function(e) {
      var from = (e.from instanceof Array) ? e.from : (e.from ? [e.from] : [StateMachine.WILDCARD]); // allow 'wildcard' transition if 'from' is not specified
      map[e.name] = map[e.name] || {};
      for (var n = 0 ; n < from.length ; n++) {
        transitions[from[n]] = transitions[from[n]] || [];
        transitions[from[n]].push(e.name);

        map[e.name][from[n]] = e.to || from[n]; // allow no-op transition if 'to' is not specified
      }
    };

    if (initial) {
      initial.event = initial.event || 'startup';
      add({ name: initial.event, from: 'none', to: initial.state });
    }

    for(var n = 0 ; n < events.length ; n++)
      add(events[n]);

    for(var name in map) {
      if (map.hasOwnProperty(name))
        fsm[name] = buildEvent(name, map[name]);
    }

    for(var name in callbacks) {
      if (callbacks.hasOwnProperty(name))
        fsm[name] = callbacks[name]
    }

    fsm.current     = 'none';
    fsm.is          = function(state) { return (state instanceof Array) ? (state.indexOf(this.current) >= 0) : (this.current === state); };
    fsm.can         = function(event) { return !this.transition && (map[event].hasOwnProperty(this.current) || map[event].hasOwnProperty(StateMachine.WILDCARD)); }
    fsm.cannot      = function(event) { return !this.can(event); };
    fsm.transitions = function()      { return transitions[this.current]; };
    fsm.isFinished  = function()      { return this.is(terminal); };
    fsm.error       = cfg.error || function(name, from, to, args, error, msg, e) { throw e || msg; }; // default behavior when something unexpected happens is to throw an exception, but caller can override this behavior if desired (see github issue #3 and #17)

    if (initial && !initial.defer)
      fsm[initial.event]();

    return fsm;

  };

  //===========================================================================

  function doCallback(fsm, func, name, from, to, args) {
    if (func) {
      try {
        return func.apply(fsm, [name, from, to].concat(args));
      }
      catch(e) {
        return fsm.error(name, from, to, args, StateMachine.Error.INVALID_CALLBACK, "an exception occurred in a caller-provided callback function", e);
      }
    }
  }

  function beforeAnyEvent(fsm, name, from, to, args) { return doCallback(fsm, fsm['onbeforeevent'],                       name, from, to, args); }
  function afterAnyEvent(fsm, name, from, to, args) { return doCallback(fsm, fsm['onafterevent'] || fsm['onevent'],      name, from, to, args); }
  function leaveAnyState(fsm, name, from, to, args) { return doCallback(fsm, fsm['onleavestate'],                        name, from, to, args); }
  function enterAnyState(fsm, name, from, to, args) { return doCallback(fsm, fsm['onenterstate'] || fsm['onstate'],      name, from, to, args); }
  function changeState(fsm, name, from, to, args) { return doCallback(fsm, fsm['onchangestate'],                       name, from, to, args); }

  function beforeThisEvent(fsm, name, from, to, args) { return doCallback(fsm, fsm['onbefore' + name],                     name, from, to, args); }
  function afterThisEvent(fsm, name, from, to, args) { return doCallback(fsm, fsm['onafter'  + name] || fsm['on' + name], name, from, to, args); }
  function leaveThisState(fsm, name, from, to, args) { return doCallback(fsm, fsm['onleave'  + from],                     name, from, to, args); }
  function enterThisState(fsm, name, from, to, args) { return doCallback(fsm, fsm['onenter'  + to]   || fsm['on' + to],   name, from, to, args); }

  function beforeEvent(fsm, name, from, to, args) {
    if ((false === beforeThisEvent(fsm, name, from, to, args)) ||
        (false === beforeAnyEvent( fsm, name, from, to, args)))
      return false;
  }

  function afterEvent(fsm, name, from, to, args) {
    afterThisEvent(fsm, name, from, to, args);
    afterAnyEvent( fsm, name, from, to, args);
  }

  function leaveState(fsm, name, from, to, args): boolean | string {
    var specific = leaveThisState(fsm, name, from, to, args),
        general  = leaveAnyState( fsm, name, from, to, args);
    if ((false === specific) || (false === general))
      return false;
    else if ((ASYNC === specific) || (ASYNC === general))
      return ASYNC;
  }

  function enterState(fsm, name, from, to, args) {
    enterThisState(fsm, name, from, to, args);
    enterAnyState( fsm, name, from, to, args);
  }

  //===========================================================================

  function buildEvent(name, map) {
    return function() {

      var from  = this.current;
      var to    = map[from] || map[StateMachine.WILDCARD] || from;
      var args  = Array.prototype.slice.call(arguments); // turn arguments into pure array

      if (this.transition)
        return this.error(name, from, to, args, Error.PENDING_TRANSITION, "event " + name + " inappropriate because previous transition did not complete");

      if (this.cannot(name))
        return this.error(name, from, to, args, Error.INVALID_TRANSITION, "event " + name + " inappropriate in current state " + this.current);

      if (false === beforeEvent(this, name, from, to, args))
        return Result.CANCELLED;

      if (from === to) {
        afterEvent(this, name, from, to, args);
        return Result.NOTRANSITION;
      }

      // prepare a transition method for use EITHER lower down, or by caller if they want an async transition (indicated by an ASYNC return value from leaveState)
      var fsm = this;
      this.transition = function() {
        fsm.transition = null; // this method should only ever be called once
        fsm.current = to;
        enterState( fsm, name, from, to, args);
        changeState(fsm, name, from, to, args);
        afterEvent( fsm, name, from, to, args);
        return Result.SUCCEEDED;
      };
      this.transition.cancel = function() { // provide a way for caller to cancel async transition if desired (issue #22)
        fsm.transition = null;
        afterEvent(fsm, name, from, to, args);
      }

      var leave = leaveState(this, name, from, to, args);
      if (false === leave) {
        this.transition = null;
        return Result.CANCELLED;
      }
      else if (ASYNC === leave) {
        return Result.PENDING;
      }
      else {
        if (this.transition) // need to check in case user manually called transition() but forgot to return StateMachine.ASYNC
          return this.transition();
      }

    };
  }
} // StateMachine
