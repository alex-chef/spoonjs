/*jshint regexp:false*/

/**
 * Controller abstract class.
 */
define([
    './Joint',
    'services/state',
    'mout/string/startsWith',
    'mout/object/size',
    'mout/object/pick',
    'mout/object/mixIn',
    'mout/object/fillIn',
    'mout/array/find',
    'has'
], function (Joint, stateRegistry, startsWith, size, pick, mixIn, fillIn, find, has) {

    'use strict';

    /**
     * Constructor.
     */
    function Controller() {
        Joint.call(this);

        this._parseStates();
        this._parseDefaultState();
    }

    Controller.prototype = Object.create(Joint.prototype);
    Controller.prototype.constructor = Controller;

    /**
     * Get the current state or null if none is set.
     *
     * @return {State} The state
     */
    Controller.prototype.getState = function () {
        return this._currentState;
    };

    /**
     * Generates an URL for a state.
     *
     * @param {String}  name       The state name
     * @param {Object}  [params]   The state params
     * @param {Boolean} [absolute] True to generate an absolute URL, false otherwise
     *
     * @return {String} The generated URL
     */
    Controller.prototype.generateUrl = function (name, params, absolute) {
        var state;

        // Resolve the state
        state = this._resolveFullState(name);
        mixIn(state.params, params);

        return stateRegistry.generateUrl(state.fullName, state.params, absolute);
    };

    /**
     * Sets the current state.
     * If the state is the same, nothing happens.
     *
     * @param {String} [name]    The state name
     * @param {Object} [params]  The state params
     * @param {Object} [options] The options
     *
     * @return {Controller} The instance itself to allow chaining
     */
    Controller.prototype.setState = function (name, params, options) {
        var stateMeta,
            state;

        // Resolve the state
        stateMeta = this._resolveFullState(name);
        mixIn(stateMeta.params, params);

        // If the state is absolute, simply set it on the state registry
        if (stateMeta.name == null) {
            stateRegistry.setCurrent(stateMeta.fullName, stateMeta.params, options);
            return this;
        }

        // Check if the state is globally registered
        if (stateRegistry.isRegistered(stateMeta.fullName)) {
            // If so attempt to change the global state, aborting if it succeeded
            if (stateRegistry.setCurrent(stateMeta.fullName, stateMeta.params, options)) {
                return this;
            }

            // Since the global state is equal, grab it to avoid creating unnecessary
            // state objects
            state = stateRegistry.getCurrent().seekTo(stateMeta.name);
        } else {
            state = stateRegistry._createStateInstance(stateMeta.name, stateMeta.params);

            // Generate local metadata
            state.getParams().$info = {
                newState: state,
                previousState: this._previousState
            };
        }

        return this.delegateState(state);
    };

    /**
     * Delegates a state to be handled by the controller.
     *
     * @param {Object|State} state The state parameter bag or a state instance
     *
     * @return {Controller} The instance itself to allow chaining
     */
    Controller.prototype.delegateState = function (state) {
        var name,
            currentState;

        // Assume app state if not passed
        if (!state) {
            state = stateRegistry.getCurrent();
        } else if (state.$info) {
            state = state.$info.newState;
        }

        // Ensure state is filled with the defaults
        this._fillStateIfEmpty(state);

        name = state.getName();

        // If still has no name it means there's no default state defined
        if (!name) {
            if (has('debug') && this._nrStates) {
                console.warn('[spoonjs] No default state defined in "' + this.$name + '".');
            }

            return;
        }

        // Check if state exists
        if (!this._states[name]) {
            if (has('debug')) {
                console.warn('[spoonjs] Unknown state "' + name + '" on controller "' + this.$name + '".');
            }

            return;
        }

        // If the current state is not the same, transition to it
        if (!this._isSameState(state)) {
            this._performStateChange(state);
        // Otherwise propagate it to child controllers
        } else {
            this._propagateState(state);
        }

        // Sync up the full state name with the application one
        // This is needed because default states might have been translated down the chain
        // Note that the current state might not be set or be changed meanwhile if the user
        // override "_performStateChange()" or "_propagateState()"
        currentState = this._currentState;
        if (stateRegistry.getCurrent() === state && currentState && currentState.getName() === name) {
            this._currentState.setFullName(state.getFullName());
        }

        return this;
    };

    /**
     * Instruct the extend to merge states.
     *
     * {@inheritDoc}
     */
    Controller.extend = function (parent, props, merge) {
        merge = merge || [];
        merge.push('_states');

        return Joint.extend.call(this, parent, props, merge);
    };

    // --------------------------------------------

    /**
     * Fills the state object with the default state if it's name is empty.
     *
     * @param {State} state The state
     */
    Controller.prototype._fillStateIfEmpty = function (state) {
        if (!this._defaultState) {
            return;
        }

        if (state.getName() === this._defaultState.name) {
            fillIn(state.getParams(), this._defaultState.params);
        } else if (!state.getName()) {
            state.setFullName(state.getFullName() + '.' + this._defaultState.name);
            fillIn(state.getParams(), this._defaultState.params);
        }
    };

    /**
     * Parses the controller states.
     */
    Controller.prototype._parseStates = function () {
        var key,
            func,
            matches,
            regExp = this.constructor._stateParamsRegExp || Controller._stateParamsRegExp,
            states = this._states;

        this._states = {};
        this._nrStates = size(states);

        // Process the states object
        for (key in states) {
            func = states[key];

            // Process the params specified in the parentheses
            matches = key.match(regExp);
            if (matches) {
                key = key.substr(0, key.indexOf('('));
                this._states[key] = {};

                // If user specified state(*), then the state changes every time
                // even if the params haven't changed
                if (matches[1] === '*') {
                    this._states[key].wildcard = true;
                } else {
                    this._states[key].params = matches[1].split(/\s*,\s*/);
                }
            } else {
                this._states[key] = {};
            }

            if (has('debug')) {
                if (!stateRegistry.isValid(key)) {
                    throw new Error('State name "' + key + '" of "' + this.$name + '" has an invalid format.');
                }
                if (key.indexOf('.') !== -1) {
                    throw new Error('State name "' + key + '" of "' + this.$name + '" must be local (cannot contain dots).');
                }
            }

            // Check if it is a string or already a function
            if (typeof func === 'string') {
                func = this[func];
                this._states[key].fn = func;
            }

            if (has('debug') && typeof func !== 'function') {
                throw new Error('State handler "' + key + '" of "' + this.$name + '" references a nonexistent function.');
            }

            this._states[key].fn = func;
            this._states[key].params = this._states[key].params || [];
        }
    };

    /**
     * Parse the default state.
     */
    Controller.prototype._parseDefaultState = function () {
        // Convert default state as a string to an object
        if (typeof this._defaultState === 'string') {
            this._defaultState = {
                name: this._defaultState,
                params: {}
            };
        }

        if (has('debug') && this._defaultState) {
            if (!this._defaultState.name) {
                throw new Error('The default state of "' + this.$name + '" cannot be empty.');
            }
            if (!this._states[this._defaultState.name]) {
                throw new Error('The default state of "' + this.$name + '" points to an nonexistent state.');
            }
        }
    },

    /**
     * Resolves a full state name.
     *
     * If name starts with a / then state is absolute.
     * If name starts with ../ then state is relative.
     * If empty will try to map to the default state.
     * Otherwise the full state name will be resolved from the local name.
     *
     * @param {String} [name] The state name
     *
     * @return {Object} The full state name and params
     */
    Controller.prototype._resolveFullState = function (name) {
        var state,
            ancestor,
            ancestorState;

        name = name || '';

        // Absolute
        if (name.charAt(0) === '/') {
            return {
                fullName: name.substr(1),
                params: {}
            };
        }

        // Relative
        if (startsWith(name, '../')) {
            if (has('debug') && (!this._uplink || !(this._uplink instanceof Controller))) {
                throw new Error('Cannot resolve relative state "' + name + '" in "' + this.$name + '".');
            }

            state = this._uplink._resolveFullState(name.substr(3));
            delete state.name;  // Remove name because state is not local

            return state;
        }

        state = {
            name: name,
            fullName: name,
            params: this._currentState ? mixIn({}, this._currentState.getParams()) : {}
        };

        // Local
        ancestor = this._uplink;
        while (ancestor && ancestor instanceof Controller) {
            ancestorState = ancestor.getState();
            if (!ancestorState) {
                // Break here, the ancestor is not in any state
                break;
            }

            // Concatenate name & mix in relevant params
            state.fullName = ancestorState.getName() + (state.fullName ? '.' + state.fullName : '');
            fillIn(state.params, ancestorState.getParams());

            ancestor = ancestor._uplink;
        }

        // If no state name is set, use default state
        if (!state.name && this._defaultState) {
            state.name = this._defaultState.name;
            state.fullName = state.fullName || this._defaultState.name;
            mixIn(state.params, this._defaultState.params);
        }

        return state;
    };

    /**
     * Checks if a given state is the same as the current controller state.
     *
     * @param {State} state       The state
     * @param {State} [baseState] The state to compare against, defaults to the current state
     *
     * @return {Boolean} True if the same, false otherwise
     */
    Controller.prototype._isSameState = function (state, baseState) {
        var stateMeta;

        baseState = baseState || this._currentState;

        if (!baseState) {
            return false;
        }

        stateMeta = this._states[state.getName()] || {};

        // Check if state is a wildcard
        if (stateMeta.wildcard) {
            return false;
        }

        // Check if equal
        return baseState.isEqual(state, stateMeta.params);
    };

    /**
     * Sets the current state based on the passed in state.
     * Updates all the necessary properties used internally.
     *
     * @param {State} state The state
     */
    Controller.prototype._setCurrentState = function (state) {
        var name,
            stateMeta;

        // Update current state
        this._previousState = this._currentState;
        this._currentState = state.clone();

        // Update the state registry one
        if (state === stateRegistry.getCurrent() && state.getFullName() !== this._currentState.getFullName()) {
            state.setFullName(this._currentState.getFullName());
        }

        name = this._currentState.getName();
        stateMeta = this._states[name];
    };

    /**
     * Performs the state change, calling the state handler if any.
     *
     * @param {State} state The state
     */
    Controller.prototype._performStateChange = function (state) {
        var stateMeta;

        // Update internal state
        this._setCurrentState(state);

        // Advance pointer
        state.next();

        // Execute handler
        stateMeta = this._states[this._currentState.getName()];
        stateMeta.fn.call(this, state.getParams());
    };

    /**
     * Attempts to propagate the state to one of the downlinks.
     *
     * @param {State} state The state
     */
    Controller.prototype._propagateState = function (state) {
        var name,
            curr,
            length,
            x;

        // Update internal state
        this._setCurrentState(state);

        // Advance pointer
        state.next();

        // Find suitable child controller to handle the state
        name = state.getName();
        length = this._downlinks.length;

        for (x = 0; x < length; x += 1) {
            curr = this._downlinks[x];

            if (!(curr instanceof Controller)) {
                continue;
            }

            // If the state has no name, check if this child has a registered default state
            if (!name) {
                if (curr._defaultState && stateRegistry.isRegistered(state.getFullName() + '.' + curr._defaultState.name)) {
                    curr.delegateState(state);
                    return;
                }
            // Otherwise check if this child has the wanted state
            } else if (curr._states[name]) {
                curr.delegateState(state);
                return;
            }
        }

        if (name && has('debug')) {
            console.warn('[spoonjs] No child controller of "' + this.$name + '" declared the "' + name + '" state.');
        }
    };

    Controller._stateParamsRegExp = /\((.+?)\)/;

    return Controller;
});
