export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      agent_portfolio_settings: {
        Row: {
          agent_enabled: boolean;
          created_at: string;
          id: string;
          portfolio_id: string;
          runs_per_day_override: number | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          agent_enabled?: boolean;
          created_at?: string;
          id?: string;
          portfolio_id: string;
          runs_per_day_override?: number | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          agent_enabled?: boolean;
          created_at?: string;
          id?: string;
          portfolio_id?: string;
          runs_per_day_override?: number | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_portfolio_settings_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: true;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_runs: {
        Row: {
          created_at: string;
          error_code: string | null;
          error_detail: string | null;
          finished_at: string | null;
          id: string;
          idempotency_key: string;
          model_main: string | null;
          model_sub: string | null;
          portfolio_id: string | null;
          scope_hash: string;
          started_at: string | null;
          status: string;
          token_usage: Json;
          trigger_type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          error_code?: string | null;
          error_detail?: string | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key: string;
          model_main?: string | null;
          model_sub?: string | null;
          portfolio_id?: string | null;
          scope_hash: string;
          started_at?: string | null;
          status?: string;
          token_usage?: Json;
          trigger_type: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          error_code?: string | null;
          error_detail?: string | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key?: string;
          model_main?: string | null;
          model_sub?: string | null;
          portfolio_id?: string | null;
          scope_hash?: string;
          started_at?: string | null;
          status?: string;
          token_usage?: Json;
          trigger_type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_runs_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_user_settings: {
        Row: {
          auto_apply_enabled: boolean;
          auto_apply_min_confidence: number;
          created_at: string;
          global_runs_per_day: number;
          timezone: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          auto_apply_enabled?: boolean;
          auto_apply_min_confidence?: number;
          created_at?: string;
          global_runs_per_day?: number;
          timezone?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          auto_apply_enabled?: boolean;
          auto_apply_min_confidence?: number;
          created_at?: string;
          global_runs_per_day?: number;
          timezone?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      benchmark_price_history: {
        Row: {
          close: number;
          date: string;
          fetched_at: string;
          ticker: string;
        };
        Insert: {
          close: number;
          date: string;
          fetched_at?: string;
          ticker: string;
        };
        Update: {
          close?: number;
          date?: string;
          fetched_at?: string;
          ticker?: string;
        };
        Relationships: [];
      };
      holdings: {
        Row: {
          asset_type: string | null;
          country_code: string | null;
          country_name: string | null;
          created_at: string;
          currency: string | null;
          fees: number;
          geography_checked_at: string | null;
          geography_confidence: number;
          geography_source: string;
          id: string;
          isin: string | null;
          name: string;
          portfolio_id: string;
          purchase_date: string;
          purchase_price: number;
          quantity: number;
          ticker: string;
          updated_at: string;
        };
        Insert: {
          asset_type?: string | null;
          country_code?: string | null;
          country_name?: string | null;
          created_at?: string;
          currency?: string | null;
          fees?: number;
          geography_checked_at?: string | null;
          geography_confidence?: number;
          geography_source?: string;
          id?: string;
          isin?: string | null;
          name: string;
          portfolio_id: string;
          purchase_date: string;
          purchase_price: number;
          quantity: number;
          ticker: string;
          updated_at?: string;
        };
        Update: {
          asset_type?: string | null;
          country_code?: string | null;
          country_name?: string | null;
          created_at?: string;
          currency?: string | null;
          fees?: number;
          geography_checked_at?: string | null;
          geography_confidence?: number;
          geography_source?: string;
          id?: string;
          isin?: string | null;
          name?: string;
          portfolio_id?: string;
          purchase_date?: string;
          purchase_price?: number;
          quantity?: number;
          ticker?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "holdings_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      holding_geography_allocations: {
        Row: {
          confidence: number;
          country_code: string;
          country_name: string;
          created_at: string;
          evidence: Json;
          holding_id: string;
          id: string;
          portfolio_id: string;
          source: string;
          updated_at: string;
          weight_pct: number;
        };
        Insert: {
          confidence?: number;
          country_code: string;
          country_name: string;
          created_at?: string;
          evidence?: Json;
          holding_id: string;
          id?: string;
          portfolio_id: string;
          source: string;
          updated_at?: string;
          weight_pct: number;
        };
        Update: {
          confidence?: number;
          country_code?: string;
          country_name?: string;
          created_at?: string;
          evidence?: Json;
          holding_id?: string;
          id?: string;
          portfolio_id?: string;
          source?: string;
          updated_at?: string;
          weight_pct?: number;
        };
        Relationships: [
          {
            foreignKeyName: "holding_geography_allocations_holding_id_fkey";
            columns: ["holding_id"];
            isOneToOne: false;
            referencedRelation: "holdings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "holding_geography_allocations_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      geography_research_jobs: {
        Row: {
          attempts: number;
          created_at: string;
          finished_at: string | null;
          holding_id: string;
          id: string;
          last_error: string | null;
          portfolio_id: string;
          reason: string | null;
          started_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          finished_at?: string | null;
          holding_id: string;
          id?: string;
          last_error?: string | null;
          portfolio_id: string;
          reason?: string | null;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          finished_at?: string | null;
          holding_id?: string;
          id?: string;
          last_error?: string | null;
          portfolio_id?: string;
          reason?: string | null;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "geography_research_jobs_holding_id_fkey";
            columns: ["holding_id"];
            isOneToOne: true;
            referencedRelation: "holdings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "geography_research_jobs_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      portfolio_snapshots: {
        Row: {
          cash_balance: number;
          computed_at: string;
          date: string;
          id: string;
          portfolio_id: string;
          securities_value: number;
          total_value: number;
        };
        Insert: {
          cash_balance: number;
          computed_at?: string;
          date: string;
          id?: string;
          portfolio_id: string;
          securities_value: number;
          total_value: number;
        };
        Update: {
          cash_balance?: number;
          computed_at?: string;
          date?: string;
          id?: string;
          portfolio_id?: string;
          securities_value?: number;
          total_value?: number;
        };
        Relationships: [
          {
            foreignKeyName: "portfolio_snapshots_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      portfolios: {
        Row: {
          cash_value: number;
          created_at: string;
          currency: string;
          description: string | null;
          id: string;
          name: string;
          primary_exchange: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          cash_value?: number;
          created_at?: string;
          currency?: string;
          description?: string | null;
          id?: string;
          name: string;
          primary_exchange?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          cash_value?: number;
          created_at?: string;
          currency?: string;
          description?: string | null;
          id?: string;
          name?: string;
          primary_exchange?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      price_history: {
        Row: {
          closing_price: number;
          date: string;
          fetched_at: string;
          id: string;
          yahoo_ticker: string;
        };
        Insert: {
          closing_price: number;
          date: string;
          fetched_at?: string;
          id?: string;
          yahoo_ticker: string;
        };
        Update: {
          closing_price?: number;
          date?: string;
          fetched_at?: string;
          id?: string;
          yahoo_ticker?: string;
        };
        Relationships: [];
      };
      saved_benchmarks: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          portfolio_id: string;
          ticker: string;
          weights: Json | null;
        };
        Insert: {
          color: string;
          created_at?: string;
          id?: string;
          name: string;
          portfolio_id: string;
          ticker: string;
          weights?: Json | null;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          name?: string;
          portfolio_id?: string;
          ticker?: string;
          weights?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "saved_benchmarks_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      transactions: {
        Row: {
          commission: number;
          created_at: string;
          date: string;
          id: string;
          isin: string | null;
          net_amount: number | null;
          portfolio_id: string;
          quantity: number | null;
          side: string;
          symbol: string;
          yahoo_ticker: string | null;
        };
        Insert: {
          commission?: number;
          created_at?: string;
          date: string;
          id?: string;
          isin?: string | null;
          net_amount?: number | null;
          portfolio_id: string;
          quantity?: number | null;
          side: string;
          symbol: string;
          yahoo_ticker?: string | null;
        };
        Update: {
          commission?: number;
          created_at?: string;
          date?: string;
          id?: string;
          isin?: string | null;
          net_amount?: number | null;
          portfolio_id?: string;
          quantity?: number | null;
          side?: string;
          symbol?: string;
          yahoo_ticker?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "transactions_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      waitlist: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          source: string;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          source?: string;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          source?: string;
        };
        Relationships: [];
      };
      watchlist_items: {
        Row: {
          id: string;
          user_id: string;
          ticker: string;
          isin: string | null;
          name: string;
          added_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          ticker: string;
          isin?: string | null;
          name: string;
          added_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          ticker?: string;
          isin?: string | null;
          name?: string;
          added_at?: string;
        };
        Relationships: [];
      };
      theses: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          content: string;
          summary: string;
          conviction: string;
          status: string;
          tickers: string[];
          body: Json;
          evidence: Json;
          attachments: Json;
          horizon: string;
          tags: string[];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          content?: string;
          summary?: string;
          conviction?: string;
          status?: string;
          tickers?: string[];
          body?: Json;
          evidence?: Json;
          attachments?: Json;
          horizon?: string;
          tags?: string[];
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          content?: string;
          summary?: string;
          conviction?: string;
          status?: string;
          tickers?: string[];
          body?: Json;
          evidence?: Json;
          attachments?: Json;
          horizon?: string;
          tags?: string[];
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
