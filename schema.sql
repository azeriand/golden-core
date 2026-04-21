--
-- PostgreSQL database dump
--

\restrict byAxtHbcXCfjrLCLXmt01WbXLIA7XimjhfdkYKIBHqpm9NeEdLO907njSuIKyyC

-- Dumped from database version 17.8 (a48d9ca)
-- Dumped by pg_dump version 18.3 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_event_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: likes; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.likes (
    user_id serial NOT NULL,
    media_id serial NOT NULL
);


ALTER TABLE public.likes OWNER TO neondb_owner;

--
-- Name: media; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.media (
    media_id serial NOT NULL,
    user_id serial NOT NULL,
    content character varying(255) NOT NULL,
    date date NOT NULL,
    section_id serial NOT NULL,
    event_id serial NOT NULL
);


ALTER TABLE public.media OWNER TO neondb_owner;

--
-- Name: sections; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.sections (
    section_id serial NOT NULL,
    section_name character varying(30) NOT NULL,
    start_date date NOT NULL,
    finish_date date NOT NULL,
    event_id serial NOT NULL
);


ALTER TABLE public.sections OWNER TO neondb_owner;

--
-- Name: events; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.events (
    event_id serial NOT NULL,
    event_name character varying(50),
    event_slug character varying(55) NOT NULL
);


ALTER TABLE public.events OWNER TO neondb_owner;

--
-- Name: users; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.users (
    user_id serial NOT NULL,
    username character varying(30) NOT NULL,
    device character varying(14) NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    event_id serial
);


ALTER TABLE public.users OWNER TO neondb_owner;

--
-- Name: likes likes_id; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT likes_id PRIMARY KEY (user_id, media_id);


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (media_id);


--
-- Name: sections sections_id; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_id PRIMARY KEY (section_id, event_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (event_id);


--
-- Name: events events_event_slug_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_event_slug_key UNIQUE (event_slug);


--
-- Name: users users_device_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_device_key UNIQUE (device);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: likes FK_likes_media_id; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_likes_media_id" FOREIGN KEY (media_id) REFERENCES public.media(media_id);


--
-- Name: likes FK_likes_user_id; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_likes_user_id" FOREIGN KEY (user_id) REFERENCES public.users(user_id);


--
-- Name: media FK_media_id; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_media_id" FOREIGN KEY (user_id) REFERENCES public.users(user_id);


--
-- Name: media FK_section_id; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_section_id" FOREIGN KEY (section_id, event_id) REFERENCES public.sections(section_id, event_id);


--
-- Name: media FK_event_id; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_event_id" FOREIGN KEY (event_id) REFERENCES public.events(event_id);


--
-- Name: users FK_users_id; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "FK_users_id" FOREIGN KEY (event_id) REFERENCES public.events(event_id);


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: cloud_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO neon_superuser WITH GRANT OPTION;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: cloud_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public GRANT ALL ON TABLES TO neon_superuser WITH GRANT OPTION;


--
-- PostgreSQL database dump complete
--

\unrestrict byAxtHbcXCfjrLCLXmt01WbXLIA7XimjhfdkYKIBHqpm9NeEdLO907njSuIKyyC

