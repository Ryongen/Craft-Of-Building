package com.cte2pob.exporter;

import com.google.gson.JsonArray;

import java.util.ArrayList;
import java.util.List;

/**
 * Everything the export could not do exactly.
 *
 * The project's standing rule is that a fixture must never contain a number nobody read off
 * the game, because such a number agrees with the engine whether or not the engine is right.
 * The same rule applies to an automated capture: where this mod cannot map what the game holds
 * onto a build document field, it says so here instead of picking something reasonable.
 */
public final class Warnings {

    private final List<String> list = new ArrayList<>();

    public void add(String message) {
        list.add(message);
    }

    public int size() {
        return list.size();
    }

    public List<String> all() {
        return list;
    }

    public JsonArray toJson() {
        JsonArray array = new JsonArray();
        for (String s : list) {
            array.add(s);
        }
        return array;
    }
}
